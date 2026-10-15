import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const URL_B = "https://youtu.be/bbbbbbbbbbb";

describe("walking skeleton: an ad hoc video crosses the four stages", () => {
  test("requesting a video creates it and queues it for download", async () => {
    const t = createTestApp();
    const res = await t.api.requestVideo(URL_A);
    expect(res.status).toBe(201);
    const video = await res.json();
    expect(video.youtubeId).toBe("aaaaaaaaaaa");
    expect(video.state).toBe("in_progress");
    expect(video.stages.map((s: any) => s.stage)).toEqual(["download", "transcription", "article", "delivery"]);
    expect(video.stages[0].status).toBe("running");
    expect(video.stages.slice(1).every((s: any) => s.status === "waiting")).toBe(true);
  });

  test("rejects a URL that is not a YouTube video", async () => {
    const t = createTestApp();
    const res = await t.api.requestVideo("https://example.com/nope");
    expect(res.status).toBe(400);
  });

  test("the video finishes as completed with every stage done", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("completed");
    expect(video.stages.map((s) => s.status)).toEqual(["done", "done", "done", "done"]);
  });

  test("stages run in order and progress is streamed over SSE", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    expect(sse.res.headers.get("content-type")).toContain("text/event-stream");
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    await sse.close();

    const runningOrder: string[] = [];
    for (const e of sse.events) {
      const running = e.stages.find((s) => s.status === "running")?.stage;
      if (running && runningOrder.at(-1) !== running) runningOrder.push(running);
    }
    expect(runningOrder).toEqual(["download", "transcription", "article", "delivery"]);
    expect(sse.events.at(-1)).toMatchObject({ id, state: "completed" });
    const percents = sse.events.flatMap((e) =>
      e.stages.filter((s) => s.stage === "download" && s.status === "running").map((s) => s.percent),
    );
    expect(percents.length).toBeGreaterThan(1);
    expect(percents).toContain(50);
  });

  test("each stage serves one video at a time, in arrival order, while different stages overlap", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    const a = await (await t.api.requestVideo(URL_A)).json();
    const b = await (await t.api.requestVideo(URL_B)).json();
    await t.clock.advance(120_000);
    await sse.close();

    const latest = new Map<number, Map<string, string>>();
    let overlapped = false;
    const startOrder: Record<string, number[]> = {};
    for (const e of sse.events) {
      latest.set(e.id, new Map(e.stages.map((s) => [s.stage, s.status])));
      for (const stage of ["download", "transcription", "article", "delivery"]) {
        const running = [...latest.entries()].filter(([, m]) => m.get(stage) === "running").map(([id]) => id);
        expect(running.length).toBeLessThanOrEqual(1);
        if (running.length === 1 && !(startOrder[stage] ??= []).includes(running[0]!)) startOrder[stage]!.push(running[0]!);
      }
      const busyStages = new Set<string>();
      for (const m of latest.values()) for (const [s, st] of m) if (st === "running") busyStages.add(s);
      if (busyStages.size >= 2) overlapped = true;
    }
    expect(overlapped).toBe(true);
    for (const order of Object.values(startOrder)) expect(order).toEqual([a.id, b.id]);
    expect((await t.api.getVideo(b.id)).state).toBe("completed");
  });

  test("pipeline state survives a restart because it lives in the database", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(60_000);
    t.app.stop();

    const t2 = createTestApp(t.dataDir);
    const video = await t2.api.getVideo(id);
    expect(video.state).toBe("completed");
    expect((await t2.api.listVideos()).map((v) => v.id)).toEqual([id]);
  });
});
