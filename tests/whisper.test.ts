import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWhisperTranscriber } from "../src/server/whisper";

const fixtures = `${import.meta.dir}/fixtures/whisper`;

/** Stand-in executables for ffmpeg and whisper-cli: the real adapter runs without a GPU, a model or real audio. */
function setup(opts: { whisper: string; ffmpeg?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "recast-whisper-"));
  const script = (name: string, body: string) => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // ffmpeg: the last argument is the output file.
  const ffmpegBin = script("ffmpeg", opts.ffmpeg ?? `for a; do out="$a"; done; echo "$@" > "${dir}/ffmpeg.args"; echo wav > "$out"`);
  const whisperBin = script("whisper-cli", `echo "$@" > "${dir}/whisper.args"\n${opts.whisper}`);
  const modelPath = join(dir, "model.bin");
  writeFileSync(modelPath, "");
  const dataDir = join(dir, "data");
  mkdirSync(join(dataDir, "audio"), { recursive: true });
  const audioPath = join(dataDir, "audio", "x.opus");
  writeFileSync(audioPath, "audio");
  return { dir, dataDir, audioPath, transcriber: createWhisperTranscriber({ dataDir, modelPath, whisperBin, ffmpegBin }) };
}
// whisper-cli stand-in that replays a recorded run: `-of` is the output path without extension.
const replay = `while [ $# -gt 0 ]; do [ "$1" = "-of" ] && of="$2"; shift; done
head -n 44 "${fixtures}/whisper.stderr.txt" >&2
sleep 0.3
tail -n +45 "${fixtures}/whisper.stderr.txt" >&2
cp "${fixtures}/transcript.json" "$of.json"`;

const ctx = (signal = new AbortController().signal) => {
  const progress: { percent: number; detail?: string }[] = [];
  return { progress, ctx: { signal, onProgress: (p: { percent: number; detail?: string }) => progress.push(p), log: () => {} } };
};

describe("whisper adapter (with stand-in executables)", () => {
  test("converts to 16 kHz mono WAV, transcribes with automatic language and returns the segments", async () => {
    const s = setup({ whisper: replay });
    const c = ctx();
    const result = await s.transcriber.transcribe(s.audioPath, c.ctx);
    expect(result.language).toBe("pt");
    expect(result.segments).toHaveLength(32);
    const ffmpegArgs = await Bun.file(join(s.dir, "ffmpeg.args")).text();
    expect(ffmpegArgs).toContain("-ar 16000 -ac 1");
    const whisperArgs = await Bun.file(join(s.dir, "whisper.args")).text();
    expect(whisperArgs).toContain("-l auto");
    expect(whisperArgs).toContain("--print-progress");
    expect(whisperArgs).toContain(`-m ${join(s.dir, "model.bin")}`);
  });

  test("reports percent with elapsed time and speed", async () => {
    const s = setup({ whisper: replay });
    const c = ctx();
    await s.transcriber.transcribe(s.audioPath, c.ctx);
    expect(c.progress.map((p) => p.percent)).toEqual([23, 44, 48, 64, 86, 100]);
    expect(c.progress[0]!.detail).toMatch(/^elapsed \d+:\d\d · \d+\.\dx audio speed$/);
  });

  test("deletes the audio and the WAV after a success, keeping temporary files in the data directory", async () => {
    const s = setup({ whisper: replay });
    await s.transcriber.transcribe(s.audioPath, ctx().ctx);
    expect(existsSync(s.audioPath)).toBe(false);
    expect(readdirSync(join(s.dataDir, "tmp"))).toEqual([]);
  });

  test("keeps the audio on a failure, still removing the WAV", async () => {
    const s = setup({ whisper: `echo "error: failed to read audio file 'x.wav'" >&2; exit 0` });
    await expect(s.transcriber.transcribe(s.audioPath, ctx().ctx)).rejects.toThrow("failed to read audio file 'x.wav'");
    expect(existsSync(s.audioPath)).toBe(true);
    expect(readdirSync(join(s.dataDir, "tmp"))).toEqual([]);
  });

  test("an exit code 0 without the output file is a failure", async () => {
    const s = setup({ whisper: "exit 0" });
    await expect(s.transcriber.transcribe(s.audioPath, ctx().ctx)).rejects.toThrow("did not produce");
  });

  test("a failing ffmpeg surfaces its last error line", async () => {
    const s = setup({ whisper: replay, ffmpeg: `echo "Error opening input file x" >&2; exit 254` });
    await expect(s.transcriber.transcribe(s.audioPath, ctx().ctx)).rejects.toThrow("Error opening input file x");
  });

  test("a missing model is reported before anything runs", async () => {
    const s = setup({ whisper: replay });
    const t = createWhisperTranscriber({ dataDir: s.dataDir, modelPath: "/nope.bin", whisperBin: join(s.dir, "whisper-cli"), ffmpegBin: join(s.dir, "ffmpeg") });
    await expect(t.transcribe(s.audioPath, ctx().ctx)).rejects.toThrow("/nope.bin");
  });

  test("cancelling kills whisper-cli and cleans up", async () => {
    const s = setup({ whisper: `echo $$ > "${join(mkdtempSync(join(tmpdir(), "p-")), "pid")}"; echo $$ > "$0.pid"; exec sleep 30` });
    const controller = new AbortController();
    const started = Date.now();
    const pending = s.transcriber.transcribe(s.audioPath, ctx(controller.signal).ctx);
    await Bun.sleep(300);
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(Date.now() - started).toBeLessThan(5000);
    const pid = Number((await Bun.file(join(s.dir, "whisper-cli.pid")).text()).trim());
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(s.audioPath)).toBe(true);
    expect(readdirSync(join(s.dataDir, "tmp"))).toEqual([]);
  });
});
