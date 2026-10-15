import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URLS = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"].map((id) => `https://youtu.be/${id}`);

describe("queue position per stage", () => {
  test("waiting videos get a 1-based FIFO position in their stage; running and finished ones have none", async () => {
    const t = createTestApp();
    for (const url of URLS) await t.api.requestVideo(url);
    const videos = await t.api.listVideos();
    const [vc, vb, va] = videos; // newest first
    expect(va!.stages[0]).toMatchObject({ status: "running", queuePosition: null });
    expect(vb!.stages[0]).toMatchObject({ status: "waiting", queuePosition: 1 });
    expect(vc!.stages[0]).toMatchObject({ status: "waiting", queuePosition: 2 });
    // a stage not queued yet has no place in any queue
    expect(va!.stages[1]).toMatchObject({ status: "waiting", queuePosition: null });

    await t.clock.advance(4_000); // A leaves download
    const after = await t.api.listVideos();
    expect(after.find((v) => v.id === vb!.id)!.stages[0]!.queuePosition).toBeNull();
    expect(after.find((v) => v.id === vc!.id)!.stages[0]!.queuePosition).toBe(1);
  });
});

describe("one Transcription at a time", () => {
  test("cancelling a Transcription does not free the executor until the process is gone", async () => {
    // The cancelled whisper-cli takes 20 more seconds to die; the next Transcription must wait for it.
    const t = createTestApp(undefined, { abortLingerMs: 20_000 });
    const { id: a } = await (await t.api.requestVideo(URLS[0]!)).json();
    const { id: b } = await (await t.api.requestVideo(URLS[1]!)).json();
    await t.clock.advance(5_000); // A is transcribing; B finishes its download at 8s
    expect((await t.api.getVideo(a)).stages[1]).toMatchObject({ status: "running" });
    await t.api.command(a, "cancel");

    await t.clock.advance(15_000); // 20s: B is ready for Transcription, A's process still dying
    expect((await t.api.getVideo(b)).stages[1]).toMatchObject({ status: "waiting" });
    expect(t.fakes.running("transcription")).toBe(1);

    await t.clock.advance(60_000);
    expect((await t.api.getVideo(b)).state).toBe("completed");
    expect(t.fakes.mostRunningAtOnce("transcription")).toBe(1);
  });
});
