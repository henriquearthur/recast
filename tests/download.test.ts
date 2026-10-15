import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

const json = (name: string) => Bun.file(`${import.meta.dir}/fixtures/ytdlp/${name}.json`).json();

describe("ad hoc video: metadata, refusal and download progress", () => {
  test("title, duration and source channel come from the metadata", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", { title: "Lesson 1", channel: "Source Channel", duration: 754 });
    const res = await t.api.requestVideo(URL_A);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ title: "Lesson 1", channelName: "Source Channel", durationSeconds: 754 });
  });

  test("the source channel of an ad hoc video does not become a Channel", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    expect(await t.api.getVideo(id)).toMatchObject({ origin: "ad_hoc", channelId: null });
  });

  for (const [name, expected] of [
    ["video-short", "Short"],
    ["video-live-in-progress", "livestream"],
    ["video-live-ended", "livestream"],
    ["video-members-only", "members"],
  ] as const) {
    test(`a request for ${name} is refused with the reason and creates nothing`, async () => {
      const t = createTestApp();
      t.fakes.publish("aaaaaaaaaaa", await json(name));
      const res = await t.api.requestVideo(URL_A);
      expect(res.status).toBe(422);
      expect((await res.json()).error).toContain(expected);
      expect(await t.api.listVideos()).toEqual([]);
    });
  }

  test("a publication that is not available yet is refused, not queued", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", await json("video-live-upcoming"));
    const res = await t.api.requestVideo(URL_A);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain("not available yet");
  });

  test("a failed metadata lookup is reported and creates nothing", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", new Error("Sign in to confirm you’re not a bot"));
    const res = await t.api.requestVideo(URL_A);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("Sign in to confirm");
    expect(await t.api.listVideos()).toEqual([]);
  });

  test("requesting a video that already exists leads to the existing one without a new lookup", async () => {
    const t = createTestApp();
    const first = await (await t.api.requestVideo(URL_A)).json();
    const second = await t.api.requestVideo("https://youtu.be/aaaaaaaaaaa");
    expect(second.status).toBe(200);
    expect((await second.json()).id).toBe(first.id);
    expect(await t.api.listVideos()).toHaveLength(1);
    expect(t.fakes.lookups).toEqual(["aaaaaaaaaaa"]);
  });

  test("the download stage reports percent, speed and time left over SSE", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    await sse.close();
    const downloading = sse.events.filter((e) => e.stages[0]!.status === "running" && e.stages[0]!.percent);
    expect(downloading.length).toBeGreaterThan(0);
    expect(downloading[0]!.stages[0]!.detail).toMatch(/KiB\/s · faltam \d+:\d\d/);
  });
});
