import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicationUnavailableError } from "../src/server/deps";
import { createYtDlp } from "../src/server/ytdlp";

/** A stand-in executable for yt-dlp: the real adapter is exercised without touching the network. */
function fakeBin(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "recast-ytdlp-"));
  const bin = join(dir, "yt-dlp");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}
const ctx = (signal = new AbortController().signal) => {
  const progress: { percent: number; detail?: string }[] = [];
  return { progress, ctx: { signal, onProgress: (p: { percent: number; detail?: string }) => progress.push(p), log: () => {} } };
};

describe("yt-dlp adapter (with a stand-in executable)", () => {
  test("all YouTube operations use the configured source address", async () => {
    const { dir, bin } = fakeBin(`
printf '%s\\n' "$@" >> "$(dirname "$0")/args"
echo '{"_type":"playlist","channel_id":"UC1","channel":"C","title":"T"}'`);
    const adapters = createYtDlp({ dataDir: dir, bin, sourceAddress: "192.168.1.10" });
    await adapters.metadata.lookup("aaaaaaaaaaa");
    await adapters.resolver.resolve("@channel");
    await adapters.downloader.download("aaaaaaaaaaa", ctx().ctx);
    const args = await Bun.file(join(dir, "args")).text();
    expect(args.match(/--source-address\n192\.168\.1\.10\n/g)).toHaveLength(3);
  });

  test("downloads into the data directory and reports progress", async () => {
    const { dir, bin } = fakeBin(`
echo "RECAST_PROGRESS downloading|500|1000|NA| 50%|2048.0|3|NA|NA"
echo "RECAST_PROGRESS finished|1000|1000|NA|100%|2048.0|NA|NA|NA"
echo "RECAST_FILE $(dirname "$0")/audio/x.opus"`);
    const { downloader } = createYtDlp({ dataDir: dir, bin });
    const c = ctx();
    const result = await downloader.download("aaaaaaaaaaa", c.ctx);
    expect(result.audioPath).toBe(join(dir, "audio", "x.opus"));
    expect(existsSync(join(dir, "audio"))).toBe(true);
    expect(c.progress[0]).toEqual({ percent: 50, detail: "2,0 KiB/s · faltam 0:03" });
  });

  test("cancelling kills the process", async () => {
    const { dir, bin } = fakeBin(`echo $$ > "$(dirname "$0")/pid"; exec sleep 30`);
    const { downloader } = createYtDlp({ dataDir: dir, bin });
    const controller = new AbortController();
    const started = Date.now();
    const pending = downloader.download("aaaaaaaaaaa", ctx(controller.signal).ctx);
    await Bun.sleep(200);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await Bun.file(join(dir, "pid")).text()).trim());
    expect(() => process.kill(pid, 0)).toThrow();
  });

  test("a failing run surfaces yt-dlp's error line", async () => {
    const { dir, bin } = fakeBin(`echo "ERROR: [youtube] aaaaaaaaaaa: This video is unavailable" >&2; exit 1`);
    const { metadata } = createYtDlp({ dataDir: dir, bin });
    await expect(metadata.lookup("aaaaaaaaaaa")).rejects.toThrow("[youtube] aaaaaaaaaaa: This video is unavailable");
  });

  test("the metadata lookup keeps only the classification fields", async () => {
    const { dir, bin } = fakeBin(`echo '{"channel_id":"UC1","channel":"C","title":"T","duration":19,"availability":"public","media_type":"video","live_status":"not_live","was_live":false,"formats":[1,2,3]}'`);
    const { metadata } = createYtDlp({ dataDir: dir, bin });
    expect(await metadata.lookup("aaaaaaaaaaa")).toEqual({
      channel_id: "UC1", channel: "C", title: "T", duration: 19, availability: "public", media_type: "video", live_status: "not_live", was_live: false,
    });
  });
  test("an unavailable publication is distinguished from service-wide blocking", async () => {
    const unavailable = fakeBin(`echo "ERROR: [youtube] aaaaaaaaaaa: This video is unavailable" >&2; exit 1`);
    const blocked = fakeBin(`echo "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot" >&2; exit 1`);
    const unavailableError = await createYtDlp({ dataDir: unavailable.dir, bin: unavailable.bin }).metadata.lookup("aaaaaaaaaaa").catch((error) => error);
    const blockedError = await createYtDlp({ dataDir: blocked.dir, bin: blocked.bin }).metadata.lookup("aaaaaaaaaaa").catch((error) => error);
    expect(unavailableError).toBeInstanceOf(PublicationUnavailableError);
    expect(blockedError).not.toBeInstanceOf(PublicationUnavailableError);
    expect(blockedError.message).toContain("not a bot");
  });

});
