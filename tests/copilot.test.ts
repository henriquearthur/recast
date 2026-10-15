import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCopilotWriter } from "../src/server/copilot";
import { ArticleWriteError, type ArticleInput } from "../src/server/deps";

const input: ArticleInput = {
  provider: "copilot",
  video: { youtubeId: "aaaaaaaaaaa", url: "https://www.youtube.com/watch?v=aaaaaaaaaaa", title: "Lesson 1", channelName: "Science Channel", durationSeconds: 754 },
  transcript: "[00:00] Lesson content.",
  instructions: "Write in English.",
  model: "gpt-6-luna",
};
function setup(outcome = "success", timeoutMs?: number) {
  const dir = mkdtempSync(join(tmpdir(), "recast-copilot-"));
  copyFileSync(`${import.meta.dir}/fixtures/copilot/runtime.js`, join(dir, "runtime.mjs"));
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ outcome }));
  const cliPath = join(dir, "copilot");
  writeFileSync(cliPath, `#!/bin/sh\nexec node '${join(dir, "runtime.mjs")}' "$@"\n`);
  chmodSync(cliPath, 0o755);
  const writer = createCopilotWriter({ cliPath, dataDir: dir, timeoutMs });
  const controller = new AbortController();
  const chunks: string[] = [];
  const ctx = { signal: controller.signal, onText: (text: string) => chunks.push(text), log: () => {}, onProgress: () => {} };
  return { dir, writer, controller, chunks, ctx };
}

describe("Copilot adapter with a substitute runtime over the real SDK", () => {
  test("sends Video metadata and Transcript, then returns streamed Article and runtime usage", async () => {
    const t = setup();
    const result = await t.writer.write(input, t.ctx);
    expect(result).toEqual({ markdown: "Test article", usage: { model: "gpt-6-luna", inputTokens: 51, outputTokens: 6, credits: 0.00081, provider: "copilot", tokensKnown: true, costUsd: 0.0000081, costKind: "equivalent", costSource: "Copilot AI credits · USD 0.01/credit" } });
    expect(t.chunks).toEqual(["Test article"]);
    const { prompt } = await Bun.file(join(t.dir, "message.json")).json();
    expect(prompt).toContain("Title: Lesson 1");
    expect(prompt).toContain("Channel: Science Channel");
    expect(prompt).toContain("Duration: 754 seconds");
    expect(prompt).toContain(input.video.url);
    expect(prompt).toContain(input.transcript);
    expect(await Bun.file(join(t.dir, "session.json")).json()).toMatchObject({ availableTools: [], systemMessage: { mode: "replace", content: input.instructions }, reasoningEffort: "low" });
  });
  test("a runtime error retains the tokens and credits consumed before the failure", async () => {
    const t = setup("error");
    const failure = await t.writer.write(input, t.ctx).catch((error) => error);
    expect(failure).toBeInstanceOf(ArticleWriteError);
    expect(failure.original.message).toContain("model error");
    expect(failure.usage).toEqual({ model: "gpt-6-luna", inputTokens: 51, outputTokens: 6, credits: 0.00081, provider: "copilot", tokensKnown: true, costUsd: 0.0000081, costKind: "equivalent", costSource: "Copilot AI credits · USD 0.01/credit" });
  });
  test("an abort followed by idle never completes the partial Article, but keeps the usage", async () => {
    const t = setup("wait");
    const failure = await t.writer.write(input, { ...t.ctx, onText: (text) => { t.chunks.push(text); t.controller.abort(); } }).catch((error) => error);
    expect(failure).toBeInstanceOf(ArticleWriteError);
    expect(failure.original.message).toContain("cancelled");
    expect(failure.usage).toEqual({ model: "gpt-6-luna", inputTokens: 51, outputTokens: 6, credits: 0.00081, provider: "copilot", tokensKnown: true, costUsd: 0.0000081, costKind: "equivalent", costSource: "Copilot AI credits · USD 0.01/credit" });
    expect(t.chunks).toEqual(["Test article"]);
  });
  test("a deadline stops a generation that never becomes idle and retains consumed usage", async () => {
    const t = setup("wait", 800);
    const failure = await t.writer.write(input, t.ctx).catch((error) => error);
    expect(failure).toBeInstanceOf(ArticleWriteError);
    expect(failure.original.message).toContain("took too long");
    expect(failure.usage).toEqual({ model: "gpt-6-luna", inputTokens: 51, outputTokens: 6, credits: 0.00081, provider: "copilot", tokensKnown: true, costUsd: 0.0000081, costKind: "equivalent", costSource: "Copilot AI credits · USD 0.01/credit" });
  });
  test("a rejection of send after usage is reported preserves consumption", async () => {
    const t = setup("send-error");
    const failure = await t.writer.write(input, t.ctx).catch((error) => error);
    expect(failure).toBeInstanceOf(ArticleWriteError);
    expect(failure.original.message).toContain("send failure");
    expect(failure.usage.inputTokens).toBe(51);
  });

  test("the deadline also cleans up a runtime that stops answering control requests", async () => {
    const t = setup("unresponsive", 800);
    const started = Date.now();
    const failure = await t.writer.write(input, t.ctx).catch((error) => error);
    expect(failure).toBeInstanceOf(ArticleWriteError);
    expect(failure.usage.inputTokens).toBe(51);
    expect(Date.now() - started).toBeLessThan(4000);
  });

});

test("Copilot missing telemetry never becomes zero cost", async () => {
  const t = setup("no-usage");
  const result = await t.writer.write(input, t.ctx);
  expect(result.usage).toMatchObject({ tokensKnown: false, credits: null, costUsd: null });
});
