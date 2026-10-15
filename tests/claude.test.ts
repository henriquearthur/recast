import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { createClaudeAdapter } from "../src/server/claude";
import { ArticleWriteError, type ArticleInput } from "../src/server/deps";
const input: ArticleInput = { provider: "claude", model: "claude-online", instructions: "Write an article.", transcript: "Content", video: { youtubeId: "aaaaaaaaaaa", url: "test", title: "Test", channelName: null, durationSeconds: 10 } };
const result = (failed = false) => ({ type: "result", subtype: failed ? "error_during_execution" : "success", is_error: failed, result: "Article", total_cost_usd: 0.03, modelUsage: { "claude-online": { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50, cacheCreationInputTokens: 20 } } });
function setup(messages: unknown[], env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "test-key" }) {
  let options: Parameters<typeof query>[0] | undefined; let closed = false;
  const run = ((args: Parameters<typeof query>[0]) => {
    options = args;
    const stream = (async function* () { for (const message of messages) yield message as SDKMessage; })();
    return Object.assign(stream, { close: () => { closed = true; } });
  }) as unknown as typeof query;
  const adapter = createClaudeAdapter({ dataDir: mkdtempSync(join("/tmp", "recast-claude-")), env, run });
  const chunks: string[] = []; const controller = new AbortController();
  return { adapter, options: () => options, closed: () => closed, controller, chunks, ctx: { signal: controller.signal, onText: (s: string) => chunks.push(s), onProgress() {}, log() {} } };
}
test("Claude streams text without duplicating the result, disables tools and records SDK estimates including cache", async () => {
  const t = setup([{ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "Article" } } }, result()]);
  const written = await t.adapter.writer.write(input, t.ctx);
  expect(written).toMatchObject({ markdown: "Article", usage: { provider: "claude", model: "claude-online", inputTokens: 170, cachedInputTokens: 50, outputTokens: 10, credits: null, costUsd: 0.03, costKind: "estimated" } });
  expect(t.chunks).toEqual(["Article"]);
  expect(t.options()?.options).toMatchObject({ model: "claude-online", systemPrompt: "Write an article.", tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], persistSession: false, env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" } });
  expect(t.closed()).toBe(true);
});
test("Claude error result preserves consumed usage and cost", async () => {
  const t = setup([result(true)]);
  const failure = await t.adapter.writer.write(input, t.ctx).catch((e) => e);
  expect(failure).toBeInstanceOf(ArticleWriteError);
  expect(failure.usage).toMatchObject({ costUsd: 0.03, inputTokens: 170 });
  expect(t.closed()).toBe(true);
});
test("Claude discovers models through the paginated online API without generating", async () => {
  const requests: string[] = [];
  const adapter = createClaudeAdapter({ dataDir: "/tmp", env: { ANTHROPIC_API_KEY: "test-key" }, fetcher: (async (url: URL) => {
    requests.push(url.toString());
    return Response.json(url.searchParams.has("after_id") ? { data: [{ id: "second", display_name: "Second" }], has_more: false } : { data: [{ id: "first", display_name: "First" }], has_more: true, last_id: "first" });
  }) as unknown as typeof fetch });
  expect((await adapter.models()).models.map((m) => m.id)).toEqual(["first", "second"]);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toContain("after_id=first");
});

test("Claude startup failure with no model usage remains unknown", async () => {
  const t = setup([{ ...result(true), modelUsage: {}, total_cost_usd: 0 }]);
  const failure = await t.adapter.writer.write(input, t.ctx).catch((e) => e);
  expect(failure.usage).toMatchObject({ tokensKnown: false, costUsd: null });
});

test("API key mode keeps the subscription token away from the runtime", async () => {
  const t = setup([result()], { ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  await t.adapter.writer.write(input, t.ctx);
  expect(t.options()?.options?.env).toMatchObject({ ANTHROPIC_API_KEY: "test-key", CLAUDE_CODE_OAUTH_TOKEN: undefined });
});

test("Without an API key, generation runs on the service user's subscription and records an API-equivalent cost", async () => {
  const t = setup([result()], { ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  const written = await t.adapter.writer.write(input, t.ctx);
  expect(t.options()?.options?.env).toMatchObject({ ANTHROPIC_API_KEY: undefined, CLAUDE_CODE_OAUTH_TOKEN: "subscription" });
  expect(written.usage).toMatchObject({ costUsd: 0.03, costKind: "equivalent", costSource: "Claude Agent SDK · API equivalent" });
});

test("Claude reports a subscription usage limit instead of a generic failure", async () => {
  const assistant = { type: "assistant", error: "rate_limit", message: { model: "claude-online", usage: { input_tokens: 0, output_tokens: 0 } } };
  const t = setup([assistant, result(true)], {});
  const failure = await t.adapter.writer.write(input, t.ctx).catch((e) => e);
  expect(failure.original.message).toBe("Claude: usage limit reached; try again later.");
});

function subscription(account: object, models: object[] = []) {
  let closed = 0; let prompted = false;
  const run = ((args: Parameters<typeof query>[0]) => {
    prompted = typeof args.prompt === "string";
    return { accountInfo: async () => account, supportedModels: async () => models, close: () => { closed++; } };
  }) as unknown as typeof query;
  const fetcher = (async () => { throw new Error("The Models API needs an API key."); }) as unknown as typeof fetch;
  return { adapter: createClaudeAdapter({ dataDir: mkdtempSync(join("/tmp", "recast-claude-")), env: {}, run, fetcher }), closed: () => closed, prompted: () => prompted };
}

test("Subscription status comes from the runtime's account, without a prompt", async () => {
  const pro = subscription({ subscriptionType: "Claude Pro" });
  expect(await pro.adapter.probe()).toEqual({ state: "authenticated", authMethod: "Claude subscription", detail: null });
  expect(pro.prompted()).toBe(false);
  expect(pro.closed()).toBe(1);
  expect((await subscription({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }).adapter.probe()).state).toBe("configured");
  expect(await subscription({ tokenSource: "none" }).adapter.probe()).toMatchObject({ state: "unconfigured", authMethod: null });
});

test("Subscription catalog lists the account's models by their canonical id, and never the runtime's bundled aliases", async () => {
  const models = [{ value: "default", resolvedModel: "claude-a", displayName: "Default" }, { value: "a", resolvedModel: "claude-a", displayName: "A" }, { value: "claude-b", displayName: "B" }];
  expect((await subscription({ subscriptionType: "Claude Max" }, models).adapter.models()).models).toEqual([{ id: "claude-a", name: "A" }, { id: "claude-b", name: "B" }]);
  await expect(subscription({ tokenSource: "none" }, models).adapter.models()).rejects.toThrow("Claude is not configured");
});
