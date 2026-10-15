import { existsSync } from "node:fs";
import { join } from "node:path";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

export interface HealthProblem {
  key: "downloader" | "converter" | "transcriber" | "model" | "copilot" | "generation" | "email";
  /** Shown to the user, in English (the interface translates it). */
  message: string;
}
export interface HealthReport {
  ok: boolean;
  problems: HealthProblem[];
}
export type HealthCheck = () => Promise<HealthReport>;

/** The external world the check looks at. Nothing here may spend Copilot credits or send e-mail. */
export interface HealthProbes {
  hasExecutable(bin: string): boolean;
  hasFile(path: string): boolean;
  copilotAuthenticated(): Promise<boolean>;
}

export interface HealthOptions {
  ytDlp: string;
  ffmpeg: string;
  whisperCli: string;
  whisperModel: string;
  env: Record<string, string | undefined>;
  /** When a Providers registry supplies the selected provider check. */
  checkCopilot?: boolean;
}

const CACHE_MS = 30_000;

/** A cheap check (no process is run except the Copilot runtime's auth query), cached briefly. */
export function createHealthCheck(probes: HealthProbes, o: HealthOptions, now: () => number = Date.now): HealthCheck {
  let cached: { at: number; report: HealthReport } | undefined;
  return async () => {
    if (cached && now() - cached.at < CACHE_MS) return cached.report;
    const problems: HealthProblem[] = [];
    const add = (key: HealthProblem["key"], message: string) => problems.push({ key, message });
    if (!probes.hasExecutable(o.ytDlp)) add("downloader", `Audio downloader (yt-dlp) not found: ${o.ytDlp}. Set YT_DLP_PATH or install yt-dlp.`);
    if (!probes.hasExecutable(o.ffmpeg)) add("converter", `Audio converter (ffmpeg) not found: ${o.ffmpeg}. Set FFMPEG_PATH or install ffmpeg.`);
    if (!probes.hasExecutable(o.whisperCli)) add("transcriber", `Transcriber (whisper-cli) not found: ${o.whisperCli}. Set WHISPER_CLI_PATH.`);
    if (!probes.hasFile(o.whisperModel)) add("model", `Transcription model not found: ${o.whisperModel}. Set WHISPER_MODEL.`);
    const authenticated = o.checkCopilot === false || await probes.copilotAuthenticated().catch(() => false);
    if (!authenticated) add("copilot", "Copilot is not authenticated: set COPILOT_GITHUB_TOKEN in the service environment file or sign in with `gh auth login`.");
    if (!o.env.RECAST_SMTP_USER || !o.env.RECAST_SMTP_PASSWORD) add("email", "Email credentials missing: set RECAST_SMTP_USER and RECAST_SMTP_PASSWORD in the service environment file.");
    const report = { ok: problems.length === 0, problems };
    cached = { at: now(), report };
    return report;
  };
}

/** Real probes. The Copilot one only asks the runtime who is logged in: no model call. */
export function realProbes(copilotCliPath: string, dataDir: string): HealthProbes {
  return {
    hasExecutable: (bin) => Bun.which(bin) !== null,
    hasFile: (path) => existsSync(path),
    async copilotAuthenticated() {
      const client = new CopilotClient({
        connection: RuntimeConnection.forStdio({ path: copilotCliPath }),
        mode: "empty",
        baseDirectory: join(dataDir, "copilot"),
      });
      try {
        await client.start();
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 10_000));
        return (await Promise.race([client.getAuthStatus(), timeout])).isAuthenticated;
      } finally {
        await client.stop().catch(() => {});
      }
    },
  };
}
