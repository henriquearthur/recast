import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCodexAdapter } from "../src/server/codex";
import { ArticleWriteError, type ArticleInput } from "../src/server/deps";
const input: ArticleInput = { provider: "codex", model: "remote-codex", instructions: "Write a faithful article.", transcript: "Transcription", video: { youtubeId: "aaaaaaaaaaa", url: "https://youtube.com/watch?v=aaaaaaaaaaa", title: "Teste", channelName: null, durationSeconds: 5 } };
function setup(outcome = "success", timeoutMs?: number, bundledOnly = false) {
  const dataDir = mkdtempSync(join("/tmp", "recast-codex-"));
  mkdirSync(join(dataDir, "codex"));
  writeFileSync(join(dataDir, "codex/scenario.json"), JSON.stringify({ outcome, bundledOnly }));
  const cli = join(dataDir, "codex-cli.mjs");
  copyFileSync(join(import.meta.dir, "fixtures/codex-runtime.js"), cli); chmodSync(cli, 0o755);
  const env = { PATH: process.env.PATH, HOME: dataDir, CODEX_HOME: join(dataDir, "auth"), CODEX_CLI_PATH: cli };
  const adapter = createCodexAdapter({ dataDir, env, timeoutMs });
  const controller = new AbortController(); const chunks: string[] = [];
  const ctx = { signal: controller.signal, onText: (s: string) => chunks.push(s), onProgress() {}, log() {} };
  return { dataDir, adapter, controller, chunks, ctx };
}
describe("Codex adapter over the real SDK with a substitute runtime", () => {
  test("streams each delta once, preserves usage and passes instructions and isolation", async () => {
    const t = setup();
    const result = await t.adapter.writer.write(input, t.ctx);
    expect(result.markdown).toBe("Complete article");
    expect(t.chunks).toEqual(["Complete", " article"]);
    expect(result.usage).toMatchObject({ provider: "codex", model: "remote-codex", inputTokens: 50, outputTokens: 5, cachedInputTokens: 10, credits: null, costUsd: null });
    const received = await Bun.file(join(t.dataDir, "codex/received.json")).json();
    expect(received.prompt).toContain("Transcription");
    expect(received.args).toContain('developer_instructions="Write a faithful article."');
    expect(received.args).toContain("read-only");
    expect(received.args).toContain("mcp_servers={}");
  });
  test("checks auth and excludes a runtime's bundled fallback from remote models", async () => {
    const t = setup();
    expect(await t.adapter.probe()).toMatchObject({ state: "authenticated", authMethod: "ChatGPT" });
    expect((await t.adapter.models()).models).toEqual([{ id: "remote-codex", name: "Remote" }]);
    expect(t.chunks).toHaveLength(0);
  });
  test("a failed turn never completes an Article and marks unreported costs as unknown", async () => {
    const t = setup("error");
    const error = await t.adapter.writer.write(input, t.ctx).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleWriteError);
    expect(error.usage).toMatchObject({ tokensKnown: false, credits: null, costUsd: null });
  });
  test("cancellation kills the runtime and rejects a partial response", async () => {
    const t = setup("wait");
    const error = await t.adapter.writer.write(input, { ...t.ctx, onText: () => t.controller.abort() }).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleWriteError);
    expect(error.usage.costUsd).toBeNull();
  });
  test("a deadline terminates an unresponsive turn", async () => {
    const t = setup("wait", 150);
    const error = await t.adapter.writer.write(input, t.ctx).catch((e) => e);
    expect(error).toBeInstanceOf(ArticleWriteError);
  });
});

test("Codex never exposes bundled models when remote discovery fails", async () => {
  const t = setup("success", undefined, true);
  await expect(t.adapter.models()).rejects.toThrow("online catalog");
}, 10_000);
test("Codex API-key catalog intersects network identifiers with runtime capabilities", async () => {
  const t = setup();
  const env = { PATH: process.env.PATH, HOME: t.dataDir, CODEX_HOME: join(t.dataDir, "auth"), CODEX_CLI_PATH: join(t.dataDir, "codex-cli.mjs"), OPENAI_API_KEY: "fake-test-key" };
  const adapter = createCodexAdapter({ dataDir: t.dataDir, env, fetcher: (async () => Response.json({ data: [{ id: "remote-codex" }, { id: "image-model" }] })) as unknown as typeof fetch });
  expect(await adapter.probe()).toMatchObject({ state: "authenticated", authMethod: "API key" });
  expect((await adapter.models()).models).toEqual([{ id: "remote-codex", name: "Remote" }]);
});
