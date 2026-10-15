import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

describe("timeline and logs", () => {
  test("each attempt has its own times, error and raw log", async () => {
    const t = createTestApp();
    t.fakes.fail("download", 1, "rede caiu");
    const id = (await (await t.api.requestVideo(URL_A)).json()).id as number;
    await t.clock.advance(4_000);
    await t.clock.advance(30_000);
    await t.clock.advance(4_000);
    const [a1, a2] = (await t.api.getAttempts(id)).filter((a) => a.stage === "download");
    expect(a1).toMatchObject({ attempt: 1, status: "failed", error: "rede caiu" });
    expect(a1!.finishedAt! - a1!.startedAt!).toBe(4_000);
    expect(a1!.log).toBe("download: 1/4\ndownload: 2/4\ndownload: 3/4\ndownload: 4/4\n");
    expect(a2).toMatchObject({ attempt: 2, status: "done", error: null });
    expect(a2!.log).toContain("download: 4/4");
  });

  test("log lines stream over SSE as they are written, and the running log is readable", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    const id = (await (await t.api.requestVideo(URL_A)).json()).id as number;
    await t.clock.advance(2_000);
    await t.clock.advance(0);
    expect(sse.logs).toEqual([
      { videoId: id, stage: "download", attempt: 1, line: "download: 1/4" },
      { videoId: id, stage: "download", attempt: 1, line: "download: 2/4" },
    ]);
    const [running] = await t.api.getAttempts(id);
    expect(running).toMatchObject({ status: "running", log: "download: 1/4\ndownload: 2/4\n" });
    await sse.close();
  });

  test("logs are kept after the video completes", async () => {
    const t = createTestApp();
    const id = (await (await t.api.requestVideo(URL_A)).json()).id as number;
    await t.clock.advance(60_000);
    expect((await t.api.getVideo(id)).state).toBe("completed");
    const attempts = await t.api.getAttempts(id);
    expect(attempts.map((a) => a.stage)).toEqual(["download", "transcription", "article", "delivery"]);
    for (const a of attempts) expect(a.log).toContain(`${a.stage}: 1/`);
  });
});
