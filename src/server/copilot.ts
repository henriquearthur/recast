import { CopilotClient, RuntimeConnection, approveAll, type CopilotSession } from "@github/copilot-sdk";
import { join } from "node:path";
import { ArticleWriteError, TranscriptTooLongError, type ArticleInput, type ArticleWriter } from "./deps";

/** Prompt tokens the default tier of the default model accepts (the 1M window needs a pricier tier we do not use). */
const MAX_PROMPT_TOKENS = 272_000;
/** Room kept for the output and the instructions. */
const OUTPUT_RESERVE_TOKENS = 32_000;
const CHARS_PER_TOKEN = 3.5;
const TIMEOUT_MS = 15 * 60_000;

export interface CopilotOptions {
  /** Path to the installed Copilot CLI runtime. */
  cliPath: string;
  /** Private state directory for the runtime. */
  dataDir: string;
  /** Deadline for a generation, including runtime startup (default: 15 minutes). */
  timeoutMs?: number;
}

/** The user message: video metadata followed by the Transcript. Instructions go in the system prompt. */
export function buildUserMessage({ video, transcript }: Pick<ArticleInput, "video" | "transcript">): string {
  return [
    `Video: ${video.url}`,
    `ID: ${video.youtubeId}`,
    `Title: ${video.title ?? "unknown"}`,
    `Channel: ${video.channelName ?? "unknown"}`,
    `Duration: ${video.durationSeconds == null ? "unknown" : `${video.durationSeconds} seconds`}`,
    "",
    "Transcript:",
    transcript,
  ].join("\n");
}

/**
 * Copilot ArticleWriter: a Copilot session with no tools, our own system prompt
 * and low reasoning effort. Authentication comes from the service environment (COPILOT_GITHUB_TOKEN)
 * or the logged-in user of the host; this file never touches a credential.
 */
export function createCopilotWriter({ cliPath, dataDir, timeoutMs = TIMEOUT_MS }: CopilotOptions): ArticleWriter {
  return {
    async write(input, ctx) {
      const message = buildUserMessage(input);
      if ((input.instructions.length + message.length) / CHARS_PER_TOKEN > (input.contextWindow ?? MAX_PROMPT_TOKENS) - Math.min(OUTPUT_RESERVE_TOKENS, (input.contextWindow ?? MAX_PROMPT_TOKENS) / 4)) {
        throw new TranscriptTooLongError("estimated before sending");
      }

      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: cliPath }),
        mode: "empty",
        baseDirectory: join(dataDir, "copilot"),
      });
      let session: CopilotSession | undefined;
      let markdown = "";
      let nanoAiu = 0;
      let tokensKnown = false;
      let creditsKnown = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let model = input.model;
      let failure: unknown;
      let stopped: Error | undefined;
      let rejectInterrupted: (error: Error) => void;
      const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject; });
      const interrupt = (error: Error) => {
        stopped = error;
        void session?.abort().catch(() => {});
        rejectInterrupted(error);
      };
      const abort = () => interrupt(new Error("Article cancelled."));
      const checkStopped = () => {
        if (stopped) throw stopped;
        ctx.signal.throwIfAborted();
      };
      const timer = setTimeout(() => interrupt(new Error("Copilot took too long to write the article.")), timeoutMs);
      ctx.signal.addEventListener("abort", abort, { once: true });
      const generate = async () => {
        checkStopped();
        await client.start();
        checkStopped();
        session = await client.createSession({
          model: input.model,
          reasoningEffort: "low",
          streaming: true,
          systemMessage: { mode: "replace", content: input.instructions },
          availableTools: [],
          infiniteSessions: { enabled: false },
          onPermissionRequest: approveAll,
        });
        checkStopped();
        let runtimeError: { errorType: string; message: string } | undefined;
        const done = new Promise<void>((resolve) => {
          session!.on((e) => {
            switch (e.type) {
              case "assistant.message_delta":
                if (!stopped && !ctx.signal.aborted) {
                  markdown += e.data.deltaContent;
                  ctx.onText(e.data.deltaContent);
                }
                break;
              case "assistant.usage":
                tokensKnown ||= e.data.inputTokens != null && e.data.outputTokens != null;
                creditsKnown ||= e.data.copilotUsage?.totalNanoAiu != null;
                inputTokens += e.data.inputTokens ?? 0;
                outputTokens += e.data.outputTokens ?? 0;
                nanoAiu += e.data.copilotUsage?.totalNanoAiu ?? 0;
                model = e.data.model ?? model;
                break;
              case "session.error":
                runtimeError = { errorType: e.data.errorType, message: e.data.message };
                resolve();
                break;
              case "session.idle":
                resolve();
                break;
            }
          });
        });
        await session.send({ prompt: message });
        await done;
        checkStopped();
        if (runtimeError) {
          const error = runtimeError as { errorType: string; message: string };
          if (error.errorType === "context_limit" || /max_prompt_tokens|context/i.test(error.message))
            throw new TranscriptTooLongError(error.message);
          throw new Error(`Copilot: ${error.message}`);
        }
      };
      try {
        await Promise.race([generate(), interrupted]);
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", abort);
        const cleanup = async () => {
          if (session) await client.deleteSession(session.sessionId).catch(() => {});
          await client.stop();
        };
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            cleanup(),
            new Promise<never>((_, reject) => {
              cleanupTimer = setTimeout(() => reject(new Error("The runtime did not shut down.")), 1000);
            }),
          ]);
        } catch {
          await client.forceStop().catch(() => {});
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
      // 1 credit = 1e9 nano AIU, as reported by the runtime. Include usage arriving while aborting/cleaning up.
      const usage = { provider: "copilot" as const, model, inputTokens, outputTokens, tokensKnown, credits: creditsKnown ? nanoAiu / 1e9 : null, costUsd: creditsKnown ? nanoAiu / 1e9 * 0.01 : null, costKind: "equivalent" as const, costSource: "Copilot AI credits · USD 0.01/credit" };
      if (!failure && !markdown.trim()) failure = new Error("Copilot: the provider did not return a complete article.");
      if (!failure && ctx.signal.aborted) failure = new Error("Article cancelled.");
      if (failure) {
        const error = failure instanceof Error ? failure : new Error(String(failure));
        if (inputTokens || outputTokens || nanoAiu) throw new ArticleWriteError(error, usage);
        throw error;
      }
      return { markdown, usage };
    },
  };
}

/** A fresh client avoids the SDK's in-memory catalog cache on every remote refresh. */
export function createCopilotAdapter(options: CopilotOptions): import("./providers").GenerationAdapter {
  const client = () => new CopilotClient({ connection: RuntimeConnection.forStdio({ path: options.cliPath }), mode: "empty", baseDirectory: join(options.dataDir, "copilot") });
  async function inspect<T>(work: (c: CopilotClient) => Promise<T>): Promise<T> {
    const c = client();
    const timer = setTimeout(() => { void c.forceStop().catch(() => {}); }, 15_000);
    try { await c.start(); return await work(c); }
    finally { clearTimeout(timer); await c.forceStop().catch(() => {}); }
  }
  return {
    writer: createCopilotWriter(options),
    async probe() {
      try {
        const auth = await inspect((c) => c.getAuthStatus());
        return { state: auth.isAuthenticated ? "authenticated" : "unconfigured", authMethod: auth.authType ?? null, detail: auth.isAuthenticated ? null : "Authenticate Copilot as the service user or set COPILOT_GITHUB_TOKEN." };
      } catch { return { state: "error", authMethod: null, detail: "Copilot unavailable: check the runtime and service user authentication." }; }
    },
    async models() {
      try {
        const models = await inspect((c) => c.listModels());
        return { models: models.filter((m) => m.policy?.state !== "disabled").map((m) => ({ id: m.id, name: m.name, contextWindow: m.capabilities.limits.max_prompt_tokens ?? m.capabilities.limits.max_context_window_tokens })), updatedAt: Date.now() };
      } catch { throw new Error("Copilot: could not retrieve the online catalog. Check authentication and connectivity."); }
    },
  };
}
