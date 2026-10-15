import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildUserMessage } from "./copilot";
import { ArticleWriteError, type ArticleUsage } from "./deps";
import type { GenerationAdapter } from "./providers";
import type { GenerationModel } from "./generation";

const UNCONFIGURED = "Set ANTHROPIC_API_KEY, or sign in with your own Claude subscription (see docs/generation.md).";
const NOT_SIGNED_IN = "Claude is not configured: set ANTHROPIC_API_KEY, or sign in with your own Claude subscription.";
const failures: Partial<Record<string, string>> = {
  authentication_failed: "Claude: authentication failed; check the service credentials.",
  rate_limit: "Claude: usage limit reached; try again later.",
};

/**
 * An API key takes precedence. Without one, the Claude Code runtime uses the service user's own subscription
 * (CLAUDE_CODE_OAUTH_TOKEN or an existing `claude` login); Recast never reads, stores or forwards that credential.
 */
export function createClaudeAdapter({ dataDir, env = process.env, timeoutMs = 15 * 60_000, fetcher = fetch, run = query }: {
  dataDir: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  run?: typeof query;
}): GenerationAdapter {
  const cwd = join(dataDir, "claude");
  const key = () => env.ANTHROPIC_API_KEY || undefined;
  // A claude.ai login would otherwise add the account's connectors (Drive, Notion…) as tools to every Article.
  const runtimeEnv = () => ({ ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "false", ...key() ? { ANTHROPIC_API_KEY: key(), CLAUDE_CODE_OAUTH_TOKEN: undefined } : { ANTHROPIC_API_KEY: undefined } });
  const isolated: Options = { cwd, tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], permissionMode: "dontAsk", persistSession: false };
  async function page(after?: string, limit = 100) {
    const url = new URL("https://api.anthropic.com/v1/models");
    url.searchParams.set("limit", String(limit));
    if (after) url.searchParams.set("after_id", after);
    const response = await fetcher(url, { headers: { "x-api-key": key()!, "anthropic-version": "2023-06-01" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Claude: model discovery failed (HTTP ${response.status}).`);
    return response.json() as Promise<{ data: { id: string; display_name: string; max_input_tokens?: number }[]; has_more: boolean; last_id?: string }>;
  }
  /** Asks the runtime about the signed-in account without sending a prompt. */
  async function inspect<T>(work: (q: Query) => Promise<T>): Promise<T> {
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const idle: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) };
    const q = run({ prompt: idle, options: { ...isolated, env: runtimeEnv() } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work(q), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Claude: the runtime did not answer.")), 30_000); })]);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }
  const signedIn = (account: Awaited<ReturnType<Query["accountInfo"]>>) => account.subscriptionType ? "authenticated" : account.tokenSource && account.tokenSource !== "none" ? "configured" : null;
  return {
    async probe() {
      if (key()) {
        try {
          await page(undefined, 1);
          return { state: "authenticated", authMethod: "API key", detail: null };
        } catch (error) {
          return { state: "configured", authMethod: "API key", detail: (error as Error).message };
        }
      }
      try {
        const state = signedIn(await inspect((q) => q.accountInfo()));
        return state ? { state, authMethod: "Claude subscription", detail: null } : { state: "unconfigured", authMethod: null, detail: UNCONFIGURED };
      } catch {
        return { state: "error", authMethod: null, detail: "Claude unavailable: check the Agent SDK runtime and the service user's authentication." };
      }
    },
    async models() {
      if (!key()) {
        const { account, models } = await inspect(async (q) => ({ account: await q.accountInfo(), models: await q.supportedModels() }));
        // Without a signed-in account the runtime only lists its bundled aliases.
        if (!signedIn(account)) throw new Error(NOT_SIGNED_IN);
        const byId = new Map<string, GenerationModel>();
        for (const m of models) if (m.value !== "default") byId.set(m.resolvedModel ?? m.value, { id: m.resolvedModel ?? m.value, name: m.displayName });
        return { models: [...byId.values()], updatedAt: Date.now() };
      }
      const models: GenerationModel[] = [];
      let after: string | undefined;
      do {
        const result = await page(after);
        models.push(...result.data.map((m) => ({ id: m.id, name: m.display_name, contextWindow: m.max_input_tokens })));
        if (!result.has_more) break;
        if (!result.last_id || result.last_id === after) throw new Error("Claude: invalid catalog pagination.");
        after = result.last_id;
      } while (models.length < 1000);
      return { models, updatedAt: Date.now() };
    },
    writer: {
      async write(input, ctx) {
        mkdirSync(cwd, { recursive: true, mode: 0o700 });
        const subscription = !key();
        const abortController = new AbortController();
        const abort = () => abortController.abort();
        ctx.signal.throwIfAborted();
        ctx.signal.addEventListener("abort", abort, { once: true });
        const timer = setTimeout(abort, timeoutMs);
        let markdown = "";
        let completed = false;
        let failure: string | undefined;
        let usage: ArticleUsage = { provider: "claude", model: input.model, inputTokens: 0, outputTokens: 0, credits: null, costUsd: null, costKind: null, costSource: null, tokensKnown: false };
        let messages: ReturnType<typeof query> | undefined;
        try {
          messages = run({ prompt: buildUserMessage(input), options: {
          ...isolated, model: input.model, systemPrompt: input.instructions,
          includePartialMessages: true, maxTurns: 1, abortController, env: runtimeEnv(),
        } });
          for await (const message of messages as AsyncIterable<SDKMessage>) {
            if (message.type === "stream_event" && !message.parent_tool_use_id && message.event.type === "content_block_delta" && message.event.delta.type === "text_delta") {
              if (!abortController.signal.aborted) {
                markdown += message.event.delta.text;
                ctx.onText(message.event.delta.text);
              }
            }
            if (message.type === "assistant") {
              failure = (message.error && failures[message.error]) ?? failure;
              // Keep already reported consumption if the runtime ends before its final result.
              usage.tokensKnown = true;
              usage.model = message.message.model;
              usage.inputTokens += message.message.usage.input_tokens + (message.message.usage.cache_read_input_tokens ?? 0) + (message.message.usage.cache_creation_input_tokens ?? 0);
              usage.outputTokens += message.message.usage.output_tokens;
            }
            if (message.type === "result") {
              const models = Object.values(message.modelUsage);
              usage = { ...usage,
                tokensKnown: models.length > 0 || usage.tokensKnown,
                model: Object.keys(message.modelUsage)[0] ?? usage.model,
                inputTokens: models.reduce((sum, m) => sum + m.inputTokens + m.cacheReadInputTokens + m.cacheCreationInputTokens, 0),
                outputTokens: models.reduce((sum, m) => sum + m.outputTokens, 0),
                cachedInputTokens: models.reduce((sum, m) => sum + m.cacheReadInputTokens, 0),
                costUsd: models.length && Number.isFinite(message.total_cost_usd) ? message.total_cost_usd : null,
                // A subscription is not billed per token: the SDK figure is what the API would have charged.
                costKind: subscription ? "equivalent" : "estimated", costSource: subscription ? "Claude Agent SDK · API equivalent" : "Claude Agent SDK",
              };
              if (message.subtype !== "success" || message.is_error) throw new Error(failure ?? "Claude: article generation failed.");
              // Older runtimes may only return final text rather than partial events.
              if (!markdown) { markdown = message.result; ctx.onText(markdown); }
              completed = true;
            }
          }
          ctx.signal.throwIfAborted();
          if (abortController.signal.aborted) throw new Error("Claude: generation timed out.");
          if (!completed || !markdown.trim()) throw new Error(failure ?? "Claude: the provider did not return a complete article.");
          return { markdown, usage };
        } catch (error) {
          throw new ArticleWriteError(error instanceof Error ? error : new Error("Claude: generation failed."), usage);
        } finally {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", abort);
          messages?.close();
        }
      },
    },
  };
}
