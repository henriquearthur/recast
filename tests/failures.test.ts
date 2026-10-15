import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";
const URL_B = "https://youtu.be/bbbbbbbbbbb";

async function start(t: ReturnType<typeof createTestApp>, url = URL_A) {
  return (await (await t.api.requestVideo(url)).json()).id as number;
}
const attemptsOf = <T extends { stage: string }>(list: T[], stage: string) => list.filter((a) => a.stage === stage);

describe("failures and automatic retries", () => {
  test("a failed stage is retried after a backoff and the video still completes", async () => {
    const t = createTestApp();
    t.fakes.fail("download", 1, "rede caiu");
    const id = await start(t);
    await t.clock.advance(4_000); // attempt 1 fails
    let video = await t.api.getVideo(id);
    expect(video.state).toBe("in_progress");
    expect(video.stages[0]).toMatchObject({ status: "waiting", attempts: 2 });
    await t.clock.advance(29_000); // still inside the 30s backoff
    expect((await t.api.getVideo(id)).stages[0]!.status).toBe("waiting");
    await t.clock.advance(60_000);
    video = await t.api.getVideo(id);
    expect(video.state).toBe("completed");
    const attempts = attemptsOf(await t.api.getAttempts(id), "download");
    expect(attempts.map((a) => [a.attempt, a.status])).toEqual([[1, "failed"], [2, "done"]]);
    expect(attempts[0]!.error).toBe("rede caiu");
  });

  test("a waiting retry does not block other videos in the same stage", async () => {
    const t = createTestApp();
    t.fakes.fail("download", 1);
    const a = await start(t);
    const b = await start(t, URL_B);
    await t.clock.advance(8_000); // A fails at 4s; B downloads 4s..8s
    expect((await t.api.getVideo(b)).stages[0]!.status).toBe("done");
    expect((await t.api.getVideo(a)).stages[0]!.status).toBe("waiting");
  });

  test("after three attempts with growing backoff the video is failed with the error visible", async () => {
    const t = createTestApp();
    t.fakes.fail("transcription", 10, "out of GPU memory");
    const id = await start(t);
    await t.clock.advance(300_000);
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("failed");
    expect(video.stages.map((s) => s.status)).toEqual(["done", "failed", "waiting", "waiting"]);
    expect(video.stages[1]).toMatchObject({ attempts: 3, error: "out of GPU memory" });
    const [a1, a2, a3] = attemptsOf(await t.api.getAttempts(id), "transcription");
    expect(a2!.startedAt! - a1!.finishedAt!).toBe(30_000);
    expect(a3!.startedAt! - a2!.finishedAt!).toBe(60_000);
  });

  test("retry resumes from the failed stage without redoing completed stages", async () => {
    const t = createTestApp();
    t.fakes.fail("transcription", 3);
    const id = await start(t);
    await t.clock.advance(300_000);
    expect((await t.api.getVideo(id)).state).toBe("failed");

    const res = await t.api.command(id, "retry");
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("in_progress");
    await t.clock.advance(60_000);
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("completed");
    const attempts = await t.api.getAttempts(id);
    expect(attemptsOf(attempts, "download")).toHaveLength(1);
    expect(attemptsOf(attempts, "transcription")).toHaveLength(4);
  });

  test("retry is refused unless the video failed", async () => {
    const t = createTestApp();
    const id = await start(t);
    expect((await t.api.command(id, "retry")).status).toBe(409);
    expect((await t.api.command(999, "retry")).status).toBe(404);
  });
});

describe("cancel and resume", () => {
  test("cancelling stops the running stage and frees the queue", async () => {
    const t = createTestApp();
    const a = await start(t);
    const b = await start(t, URL_B);
    await t.clock.advance(2_000);
    const res = await t.api.command(a, "cancel");
    expect(res.status).toBe(200);
    const video = await t.api.getVideo(a);
    expect(video.state).toBe("cancelled");
    expect(video.stages.map((s) => s.status)).toEqual(["cancelled", "waiting", "waiting", "waiting"]);

    await t.clock.advance(120_000);
    expect((await t.api.getVideo(b)).state).toBe("completed");
    const after = await t.api.getVideo(a);
    expect(after.state).toBe("cancelled");
    expect(after.stages[0]!.status).toBe("cancelled");
  });

  test("cancelling preserves finished stages and resume continues from the stage that stopped", async () => {
    const t = createTestApp();
    const id = await start(t);
    await t.clock.advance(6_000); // download done, transcription running
    await t.api.command(id, "cancel");
    const cancelled = await t.api.getVideo(id);
    expect(cancelled.stages.map((s) => s.status)).toEqual(["done", "cancelled", "waiting", "waiting"]);

    const res = await t.api.command(id, "resume");
    expect(res.status).toBe(200);
    await t.clock.advance(60_000);
    expect((await t.api.getVideo(id)).state).toBe("completed");
    const attempts = await t.api.getAttempts(id);
    expect(attemptsOf(attempts, "download")).toHaveLength(1);
    expect(attemptsOf(attempts, "transcription").map((a) => a.status)).toEqual(["cancelled", "done"]);
  });

  test("cancel needs a video in progress and resume a cancelled one", async () => {
    const t = createTestApp();
    const id = await start(t);
    expect((await t.api.command(id, "resume")).status).toBe(409);
    await t.clock.advance(60_000);
    expect((await t.api.command(id, "cancel")).status).toBe(409);
  });
});

describe("recovery on startup", () => {
  test("a stage found running goes back to the queue, restarts from zero and keeps its attempt", async () => {
    const t = createTestApp();
    const id = await start(t);
    await t.clock.advance(2_000);
    expect((await t.api.getVideo(id)).stages[0]).toMatchObject({ status: "running", percent: 50 });
    t.app.stop();

    const t2 = createTestApp(t.dataDir);
    const video = await t2.api.getVideo(id);
    expect(video.stages[0]).toMatchObject({ status: "running", percent: 0, attempts: 1 });
    await t2.clock.advance(60_000);
    expect((await t2.api.getVideo(id)).state).toBe("completed");
    const attempts = await t2.api.getAttempts(id);
    expect(attemptsOf(attempts, "download").map((a) => [a.attempt, a.status])).toEqual([[1, "done"]]);
  });
});
