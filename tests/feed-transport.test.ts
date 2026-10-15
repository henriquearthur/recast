import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRssFeed } from "../src/server/feed";

function fakeCurl(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "recast-feed-"));
  const bin = join(dir, "curl");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

const xml = '<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>Video</title><published>2026-10-07T12:00:00Z</published></entry></feed>';

test("RSS keeps the fetch transport when bypass is absent", async () => {
  const controller = new AbortController();
  const fetchImpl = (async (url, init) => {
    expect(String(url)).toEndWith("channel_id=UC1");
    expect(init?.signal).toBe(controller.signal);
    return new Response(xml);
  }) as typeof fetch;
  expect(await createRssFeed(fetchImpl).fetchFeed("UC1", controller.signal)).toHaveLength(1);
});

test("RSS binds curl to IPv4 and parses the feed without calling fetch", async () => {
  const { dir, bin } = fakeCurl(`printf '%s\\n' "$@" > "$(dirname "$0")/args"\necho '${xml}'`);
  const fetchImpl = (async () => { throw new Error("unexpected fetch"); }) as unknown as typeof fetch;
  const feed = createRssFeed(fetchImpl, { sourceAddress: "192.168.1.10", curlBin: bin });
  expect(await feed.fetchFeed("UC1")).toHaveLength(1);
  expect((await Bun.file(join(dir, "args")).text()).split("\n")).toEqual([
    "--ipv4", "--interface", "192.168.1.10", "--fail", "--silent", "--show-error",
    "https://www.youtube.com/feeds/videos.xml?channel_id=UC1", "",
  ]);
});

test("HTTP/network failures are not interpreted as an empty feed", async () => {
  const { bin } = fakeCurl('echo "curl: (22) HTTP 503" >&2; exit 22');
  const feed = createRssFeed(fetch, { sourceAddress: "192.168.1.10", curlBin: bin });
  await expect(feed.fetchFeed("UC1")).rejects.toThrow("HTTP 503");
});

test("cancelling a feed request kills curl", async () => {
  const { dir, bin } = fakeCurl('echo $$ > "$(dirname "$0")/pid"; exec sleep 30');
  const controller = new AbortController();
  const pending = createRssFeed(fetch, { sourceAddress: "192.168.1.10", curlBin: bin }).fetchFeed("UC1", controller.signal);
  for (let i = 0; i < 100 && !(await Bun.file(join(dir, "pid")).exists()); i++) await Bun.sleep(10);
  controller.abort();
  await expect(pending).rejects.toThrow("cancelled");
  const pid = Number(await Bun.file(join(dir, "pid")).text());
  expect(() => process.kill(pid, 0)).toThrow();
});
