import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

async function completed(t: ReturnType<typeof createTestApp>) {
  const { id } = await (await t.api.requestVideo(URL_A)).json();
  await t.clock.advance(60_000);
  return id as number;
}

const regenerate = (t: ReturnType<typeof createTestApp>, id: number, body?: unknown) =>
  t.request(`/api/videos/${id}/regenerate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

describe("article regeneration", () => {
  test("reruns only the Article stage from the existing transcript, then resends the e-mail", async () => {
    const t = createTestApp();
    const id = await completed(t);
    const before = await t.api.getAttempts(id);
    expect((await regenerate(t, id)).status).toBe(200);
    await t.clock.advance(60_000);
    const after = await t.api.getAttempts(id);
    const added = after.slice(before.length).map((a) => a.stage);
    expect(added).toEqual(["article", "delivery"]);
    expect(t.fakes.writes).toHaveLength(2);
    expect(t.fakes.writes[1]!.transcript).toBe("[00:00] fake transcript text");
    expect(t.fakes.sent).toHaveLength(2);
    expect((await t.api.getVideo(id)).state).toBe("completed");
  });

  test("regeneration uses the current globally selected model", async () => {
    const t = createTestApp();
    const id = await completed(t);
    await t.api.putSetting("model", "claude-sonnet-5.5");
    await regenerate(t, id);
    await t.clock.advance(60_000);
    expect(t.fakes.writes[1]!.model).toBe("claude-sonnet-5.5");
    expect((await t.api.getSettings()).model).toBe("claude-sonnet-5.5");
    const video = await t.api.getVideo(id);
    expect(video.article!.usage!.model).toBe("claude-sonnet-5.5");
  });

  test("the new article replaces the old one and a new usage record is added", async () => {
    const t = createTestApp();
    const id = await completed(t);
    const first = (await t.api.getVideo(id)).article!.markdown;
    await regenerate(t, id);
    await t.clock.advance(60_000);
    expect((await t.api.getCosts()).total.generations).toBe(2);
    expect(await (await t.request("/api/articles")).json()).toHaveLength(1);
    expect((await t.api.getVideo(id)).article!.markdown).toBe(first);
  });

  test("while regenerating, and after it fails, the previous article stays available", async () => {
    const t = createTestApp();
    const id = await completed(t);
    const first = (await t.api.getVideo(id)).article!.markdown;
    t.fakes.fail("article", 3);
    await regenerate(t, id);
    await t.clock.advance(1500);
    const during = await t.api.getVideo(id);
    expect(during.article).toMatchObject({ markdown: first, complete: true });
    await t.clock.advance(10 * 60_000);
    const failed = await t.api.getVideo(id);
    expect(failed.state).toBe("failed");
    expect(failed.article).toMatchObject({ markdown: first, complete: true });
    expect(t.fakes.sent).toHaveLength(1);
    expect((await t.api.getCosts()).total.generations).toBe(1);
  });

  test("a retry after a failed regeneration keeps the chosen model", async () => {
    const t = createTestApp();
    const id = await completed(t);
    t.fakes.fail("article", 3);
    await t.api.putSetting("model", "claude-sonnet-5.5");
    await regenerate(t, id);
    await t.clock.advance(10 * 60_000);
    await t.api.command(id, "retry");
    await t.clock.advance(60_000);
    expect(t.fakes.writes.at(-1)!.model).toBe("claude-sonnet-5.5");
    expect((await t.api.getVideo(id)).state).toBe("completed");
  });

  test("only completed videos can be regenerated", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    expect((await regenerate(t, id)).status).toBe(409);
    expect((await regenerate(t, 999)).status).toBe(404);
    await t.clock.advance(60_000);
    expect((await regenerate(t, id, { model: 5 })).status).toBe(400);
  });

  test("cancelling a regeneration whose writer still returns afterwards keeps the previous article", async () => {
    const t = createTestApp(undefined, { writerIgnoresAbort: true });
    const id = await completed(t);
    const first = (await t.api.getVideo(id)).article!.markdown;
    await t.api.putSetting("model", "claude-sonnet-5.5");
    await regenerate(t, id);
    await t.clock.advance(1500); // partway through the writing
    expect((await t.api.command(id, "cancel")).status).toBe(200);
    await t.clock.advance(60_000); // the writer returns anyway
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("cancelled");
    expect(video.article).toMatchObject({ markdown: first, complete: true, draft: null });
    expect(video.article!.usage!.model).toBe("gpt-6-luna");
    expect(t.fakes.sent).toHaveLength(1);
  });

  test("a regeneration is shown being written while the previous article stays available", async () => {
    const t = createTestApp();
    const id = await completed(t);
    const first = (await t.api.getVideo(id)).article!.markdown;
    const sse = await t.subscribe();
    await regenerate(t, id);
    await t.clock.advance(2500); // two pieces written
    const during = await t.api.getVideo(id);
    expect(during.article).toMatchObject({ markdown: first, complete: true });
    expect(during.article!.draft).toBe("- fake summary\n\n## Section\n\n");
    expect(sse.chunks.map((c) => c.offset)).toEqual([0, "- fake summary\n\n".length]);

    await t.clock.advance(60_000);
    await sse.close();
    const done = await t.api.getVideo(id);
    expect(done.article!.draft).toBeNull();
    expect(done.article!.markdown).toBe(first);
  });

  test("a failed regeneration leaves no draft behind", async () => {
    const t = createTestApp();
    const id = await completed(t);
    t.fakes.fail("article", 3);
    await regenerate(t, id);
    await t.clock.advance(10 * 60_000);
    expect((await t.api.getVideo(id)).article!.draft).toBeNull();
  });
});
