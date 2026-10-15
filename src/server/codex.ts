import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Codex } from "@openai/codex-sdk";
import { buildUserMessage } from "./copilot";
import { ArticleWriteError, type ArticleUsage } from "./deps";
import type { GenerationAdapter } from "./providers";
import type { GenerationModel } from "./generation";

/** SDK and catalog discovery must use the same installed runtime and host authentication. */
export function codexCommand(env: Record<string, string | undefined>): string {
  return env.CODEX_CLI_PATH ?? join(dirname(createRequire(import.meta.url).resolve("@openai/codex/package.json")), "bin/codex.js");
}

/** A bounded stdio RPC connection; no inference, no login, no token returned to the application. */
export async function withCodexServer<T>(cli: string, cwd: string, env: Record<string, string | undefined>, work: (rpc: <R>(method: string, params: object) => Promise<R>) => Promise<T>): Promise<T> {
  const child = spawn(cli, ["app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let id = 0;
  const fail = () => { for (const p of pending.values()) p.reject(new Error("Codex: the runtime did not answer the request.")); pending.clear(); };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", fail);
  child.stderr.resume(); // Runtime diagnostics can contain paths/configuration: never forward raw output.
  const reader = (async () => {
    let buffer = "";
    for await (const chunk of child.stdout) {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const response = JSON.parse(line);
          const p = pending.get(response.id);
          if (p) {
            pending.delete(response.id);
            if (response.error) p.reject(new Error("Codex: the runtime refused the request."));
            else p.resolve(response.result);
          }
        } catch { /* Ignore non-protocol diagnostics. */ }
      }
    }
  })();
  const rpc = <R>(method: string, params: object): Promise<R> => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve: (v) => resolve(v as R), reject });
    child.stdin.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail(); child.kill("SIGKILL"); }, 20_000);
  try {
    await rpc("initialize", { clientInfo: { name: "recast", version: "1.0.0" } });
    child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
    return await work(rpc);
  } finally {
    clearTimeout(timer);
    fail();
    child.kill("SIGKILL");
    await reader.catch(() => {});
  }
}

export function createCodexAdapter({ dataDir, env = process.env, timeoutMs = 15 * 60_000, create = (options) => new Codex(options), connect = withCodexServer, fetcher = fetch }: {
  dataDir: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  create?: (options: ConstructorParameters<typeof Codex>[0]) => Pick<Codex, "startThread">;
  connect?: typeof withCodexServer;
  fetcher?: typeof fetch;
}): GenerationAdapter {
  const cwd = join(dataDir, "codex");
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const cli = codexCommand(env);
  const runtimeEnv = { ...env };
  // Codex SDK sets this for apiKey too; preserve the same authentication for catalog queries.
  if (env.OPENAI_API_KEY && !env.CODEX_API_KEY) runtimeEnv.CODEX_API_KEY = env.OPENAI_API_KEY;
  const home = env.CODEX_HOME ?? join(env.HOME ?? "/tmp", ".codex");
  const apiKey = env.CODEX_API_KEY ?? env.OPENAI_API_KEY;
  async function apiModels() {
    const response = await fetcher("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Codex: model discovery failed (HTTP ${response.status}).`);
    return response.json() as Promise<{ data: { id: string }[] }>;
  }
  return {
    async probe() {
      try {
        return await connect(cli, cwd, runtimeEnv, async (rpc) => {
          if (apiKey) {
            await apiModels();
            return { state: "authenticated", authMethod: "API key", detail: null };
          }
          const result = await rpc<{ account: { type: string } | null }>("account/read", { refreshToken: false });
          return result.account
            ? { state: "authenticated", authMethod: result.account.type === "apiKey" ? "API key" : "ChatGPT", detail: null }
            : { state: "unconfigured", authMethod: null, detail: "Run codex login as the service user or configure an API key." };
        });
      } catch { return { state: "error", authMethod: null, detail: "Codex unavailable: check the runtime and service user authentication." }; }
    },
    async models() {
      return connect(cli, cwd, runtimeEnv, async (rpc) => {
        const all: GenerationModel[] = [];
        let cursor: string | null = null;
        do {
          const page: { data: { model: string; displayName: string }[]; nextCursor: string | null } = await rpc("model/list", { limit: 100, cursor, includeHidden: false });
          all.push(...page.data.map((m) => ({ id: m.model, name: m.displayName })));
          if (page.nextCursor === cursor && cursor) throw new Error("Codex: invalid catalog pagination.");
          cursor = page.nextCursor;
        } while (cursor && all.length < 1000);
        if (apiKey) {
          const remote = await apiModels();
          const ids = new Set(remote.data.map((m) => m.id));
          // Runtime capabilities filter out non-Codex model families, but identifiers come from the network.
          const models = all.filter((m) => ids.has(m.id));
          if (!models.length) throw new Error("Codex: no compatible model is available for this account.");
          return { models, updatedAt: Date.now() };
        }
        // model/list can fall back to bundled models. Only accept entries actually fetched remotely.
        // The runtime refreshes online at startup; allow it to finish without trusting bundled data.
        for (let attempt = 0; attempt < 30; attempt++) {
          const cache = await readFile(join(home, "models_cache.json"), "utf8").then(JSON.parse).catch(() => null);
          const at = cache ? Date.parse(cache.fetched_at) : NaN;
          if (Number.isFinite(at) && Date.now() - at < 5 * 60_000 && Array.isArray(cache.models)) {
            const remote = new Set<string>(cache.models.map((m: { slug: string }) => m.slug));
            const current: GenerationModel[] = [];
            let next: string | null = null;
            do {
              const page: { data: { model: string; displayName: string }[]; nextCursor: string | null } = await rpc("model/list", { limit: 100, cursor: next, includeHidden: false });
              current.push(...page.data.map((m) => ({ id: m.model, name: m.displayName })));
              if (page.nextCursor === next && next) throw new Error("Codex: invalid catalog pagination.");
              next = page.nextCursor;
            } while (next && current.length < 1000);
            const models = current.filter((m) => remote.has(m.id));
            if (models.length) return { models, updatedAt: at };
          }
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        throw new Error("Codex: could not verify a current online catalog. The last Recast catalog was preserved.");
      });
    },
    writer: {
      async write(input, ctx) {
        const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
        const codex = create({ codexPathOverride: cli, apiKey: env.CODEX_API_KEY ?? env.OPENAI_API_KEY,
          env: Object.fromEntries(Object.entries(runtimeEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)),
          config: { developer_instructions: input.instructions, features: { shell_tool: false, unified_exec: false, apply_patch_freeform: false } },
          configOverrides: ["mcp_servers={}"],
        });
        const thread = codex.startThread({ model: input.model, workingDirectory: cwd, sandboxMode: "read-only", approvalPolicy: "never", skipGitRepoCheck: true, networkAccessEnabled: false, webSearchMode: "disabled" });
        let markdown = "";
        let completed = false;
        let usage: ArticleUsage = { provider: "codex", model: input.model, inputTokens: 0, outputTokens: 0, credits: null, costUsd: null, costKind: null, costSource: null, tokensKnown: false };
        const texts = new Map<string, string>();
        try {
          const { events } = await thread.runStreamed(buildUserMessage(input), { signal });
          for await (const event of events) {
            if (event.type === "error") throw new Error("Codex: article generation failed.");
            if (event.type === "turn.failed") throw new Error("Codex: the provider rejected or interrupted generation.");
            if ((event.type === "item.updated" || event.type === "item.completed") && event.item.type === "agent_message") {
              const before = texts.get(event.item.id) ?? "";
              const text = event.item.text;
              if (!text.startsWith(before)) throw new Error("Codex: inconsistent text update.");
              const delta = text.slice(before.length);
              texts.set(event.item.id, text);
              if (!signal.aborted && delta) { markdown += delta; ctx.onText(delta); }
            }
            if (event.type === "turn.completed") {
              usage = { ...usage, inputTokens: event.usage.input_tokens, outputTokens: event.usage.output_tokens, tokensKnown: true, cachedInputTokens: event.usage.cached_input_tokens, cacheWriteInputTokens: event.usage.cache_write_input_tokens };
              completed = true;
            }
          }
          signal.throwIfAborted();
          if (!completed || !markdown.trim()) throw new Error("Codex: the provider did not return a complete article.");
          return { markdown, usage };
        } catch (error) {
          throw new ArticleWriteError(error instanceof Error ? error : new Error("Codex: generation failed."), usage);
        }
      },
    },
  };
}
