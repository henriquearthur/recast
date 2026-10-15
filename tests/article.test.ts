import { describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const URL_A = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

async function runToCompletion(t: ReturnType<typeof createTestApp>) {
  const { id } = await (await t.api.requestVideo(URL_A)).json();
  await t.clock.advance(60_000);
  return id as number;
}

describe("settings", () => {
  test("default model is GPT-6 Luna and the global prompt defines the article format", async () => {
    const t = createTestApp();
    const settings = await t.api.getSettings();
    expect(settings.model).toBe("gpt-6-luna");
    expect(settings.articleLanguage).toBe("en");
    expect(settings.globalPrompt).toMatch(/3 to 5 bullet points/);
    expect(settings.globalPrompt).toContain("## TL;DR");
    expect(settings.globalPrompt).toContain("in the first person");
  });

  test("settings can be changed and persist across restarts", async () => {
    const t = createTestApp();
    expect((await t.api.putSetting("model", "claude-sonnet-5.5")).status).toBe(200);
    expect((await t.api.putSetting("globalPrompt", "Write briefly.")).status).toBe(200);
    expect(await t.api.getSettings()).toMatchObject({ model: "claude-sonnet-5.5", globalPrompt: "Write briefly." });
    t.app.stop();
    const t2 = createTestApp(t.dataDir);
    expect((await t2.api.getSettings()).model).toBe("claude-sonnet-5.5");
  });
});

describe("article writing", () => {
  test("the writer receives transcript, video metadata, the global prompt as instructions and the chosen model", async () => {
    const t = createTestApp();
    await t.api.putSetting("globalPrompt", "GLOBAL PROMPT");
    await t.api.putSetting("model", "gpt-5.4-mini");
    await runToCompletion(t);
    expect(t.fakes.writes).toHaveLength(1);
    expect(t.fakes.writes[0]).toMatchObject({
      transcript: "[00:00] fake transcript text",
      video: { youtubeId: "aaaaaaaaaaa", url: URL_A },
      instructions: "GLOBAL PROMPT\n\nWrite the article in English (en), whatever the language of the transcript.",
      model: "gpt-5.4-mini",
    });
  });

  test("article text is streamed over SSE while it is being written", async () => {
    const t = createTestApp();
    const sse = await t.subscribe();
    const id = await runToCompletion(t);
    await sse.close();
    expect(sse.chunks.length).toBeGreaterThan(1);
    expect(sse.chunks.every((c) => c.id === id)).toBe(true);
    let offset = 0;
    for (const c of sse.chunks) {
      expect(c.offset).toBe(offset);
      offset += c.delta.length;
    }
    const video = await t.api.getVideo(id);
    expect(sse.chunks.map((c) => c.delta).join("")).toBe(video.article!.markdown);
  });

  test("the finished article is on the video together with its usage", async () => {
    const t = createTestApp();
    const id = await runToCompletion(t);
    const video = await t.api.getVideo(id);
    expect(video.article).toMatchObject({
      complete: true,
      usage: { model: "gpt-6-luna", inputTokens: 1200, outputTokens: 300, credits: 0.027 },
    });
    expect(video.article!.markdown).toContain(URL_A);
  });

  test("a partial article is visible on the video while the stage is running", async () => {
    const t = createTestApp();
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(9_000);
    const video = await t.api.getVideo(id);
    expect(video.stages[2]).toMatchObject({ stage: "article", status: "running" });
    expect(video.article).toMatchObject({ complete: false, usage: null });
    expect(video.article!.markdown.length).toBeGreaterThan(0);
  });

  test("each generation records its usage, and a later regeneration does not rewrite the earlier record", async () => {
    const t = createTestApp();
    const id = await runToCompletion(t);
    const first = await t.api.getCosts();
    expect(first.total).toMatchObject({ inputTokens: 1200, outputTokens: 300, generations: 1 });
    expect(first.total.credits).toBeCloseTo(0.027, 10);
    await t.api.putSetting("model", "claude-sonnet-5.5");
    await t.request(`/api/videos/${id}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await t.clock.advance(60_000);
    const second = await t.api.getCosts();
    expect(second.total.generations).toBe(2);
    expect(second.byModel.map((m) => [m.model, m.generations]).sort()).toEqual([
      ["claude-sonnet-5.5", 1],
      ["gpt-6-luna", 1],
    ]);
  });

  test("a transcript that does not fit the model fails the stage with an explicit error and records no usage", async () => {
    const t = createTestApp(undefined, { maxTranscriptChars: 10 });
    const id = await runToCompletion(t);
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("failed");
    const article = video.stages.find((s) => s.stage === "article")!;
    expect(article.status).toBe("failed");
    expect(article.error).toContain("does not fit");
    expect((await t.api.getCosts()).total.generations).toBe(0);
  });

  test("the writer receives the metadata of the Video along with the transcript and the instructions", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", { title: "Lesson 1", channel: "Source Channel", duration: 754 });
    await runToCompletion(t);
    expect(t.fakes.writes[0]!.video).toEqual({
      youtubeId: "aaaaaaaaaaa",
      url: URL_A,
      title: "Lesson 1",
      channelName: "Source Channel",
      durationSeconds: 754,
    });
  });

  test("a generation that fails after consuming tokens still records its usage", async () => {
    const t = createTestApp();
    t.fakes.fail("article", 1, "timeout do Copilot", { consumed: true });
    const id = await runToCompletion(t); // fails once, the retry 30s later succeeds
    expect((await t.api.getVideo(id)).state).toBe("completed");
    const { total, byModel } = await t.api.getCosts();
    expect(total).toMatchObject({ generations: 2, inputTokens: 1200 + 1200, outputTokens: 40 + 300 });
    expect(total.credits).toBeCloseTo(0.003 + 0.027, 10);
    expect(byModel).toMatchObject([{ model: "gpt-6-luna", generations: 2 }]);
  });

  test("a failure that reports no consumption records nothing", async () => {
    const t = createTestApp();
    t.fakes.fail("article", 3, "no usage");
    const id = await runToCompletion(t);
    await t.clock.advance(10 * 60_000);
    expect((await t.api.getVideo(id)).state).toBe("failed");
    expect((await t.api.getCosts()).total.generations).toBe(0);
  });

  test("a writer that returns after the video was cancelled stores nothing but its usage is recorded", async () => {
    const t = createTestApp(undefined, { writerIgnoresAbort: true });
    const { id } = await (await t.api.requestVideo(URL_A)).json();
    await t.clock.advance(9_500); // the Article is being written
    await t.api.command(id, "cancel");
    await t.clock.advance(60_000);
    const video = await t.api.getVideo(id);
    expect(video.state).toBe("cancelled");
    expect(video.article).toMatchObject({ complete: false });
    expect((await t.api.getCosts()).total.generations).toBe(1);
  });
});
