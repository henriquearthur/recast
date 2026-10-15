import { describe, expect, test } from "bun:test";
import { formatTranscript } from "../src/server/transcript";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

describe("transcription stage", () => {
  test("the transcript is stored with times in the original language and served to the video page", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    const res = await t.request(`/api/videos/${id}/transcript`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      language: "en",
      segments: [{ startMs: 0, endMs: 4000, text: "fake transcript text" }],
    });
  });

  test("there is no transcript before the stage finishes", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    expect((await t.request(`/api/videos/${id}/transcript`)).status).toBe(404);
    expect((await t.request("/api/videos/999/transcript")).status).toBe(404);
  });

  test("the article stage reads the timestamped transcript", async () => {
    const t = createTestApp();
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    expect(t.fakes.writes[0]!.transcript).toBe("[00:00] fake transcript text");
  });

  test("progress shows percent, elapsed time and speed over SSE", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    await t.api.requestVideo(URL_A);
    await t.clock.advance(60_000);
    await sse.close();
    const running = sse.events.filter((e) => e.stages[1]!.status === "running" && e.stages[1]!.percent);
    expect(running.length).toBeGreaterThan(0);
    expect(running[0]!.stages[1]!.detail).toMatch(/^elapsed \d+:\d\d · \d+\.\dx audio speed$/);
  });

  test("a retried transcription replaces the stored transcript", async () => {
    const t = createTestApp();
    t.fakes.fail("transcription", 1);
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(120_000);
    expect((await t.api.getVideo(id)).state).toBe("completed");
    const transcript = await (await t.request(`/api/videos/${id}/transcript`)).json();
    expect(transcript.segments).toHaveLength(1);
  });
});

describe("formatTranscript", () => {
  test("puts the start time before each segment, with hours when needed", () => {
    expect(
      formatTranscript([
        { startMs: 0, endMs: 1000, text: "a" },
        { startMs: 75_000, endMs: 80_000, text: "b" },
        { startMs: 3_725_000, endMs: 3_730_000, text: "c" },
      ]),
    ).toBe("[00:00] a\n[01:15] b\n[1:02:05] c");
  });
});
