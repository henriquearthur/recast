import { join } from "node:path";
import { isIPv4 } from "node:net";

export interface Config {
  dataDir: string;
  /** Interface the server listens on: only this machine by default, since Recast has no authentication. */
  host: string;
  port: number;
  copilotCliPath: string;
  ytDlpPath: string;
  jsRuntime: string;
  youtubeSourceAddress?: string;
  ffmpegPath: string;
  whisperCliPath: string;
  whisperModel: string;
  /** Public address of the UI, used for links in e-mails. */
  baseUrl: string;
}

/** Data (database, audio, logs) lives outside the repository; override with RECAST_DATA_DIR. */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const port = Number(env.RECAST_PORT ?? 4280);
  const youtubeSourceAddress = env.RECAST_YOUTUBE_SOURCE_ADDRESS?.trim() || undefined;
  if (youtubeSourceAddress && !isIPv4(youtubeSourceAddress)) throw new Error("RECAST_YOUTUBE_SOURCE_ADDRESS must be a local IPv4 address");
  return {
    dataDir: env.RECAST_DATA_DIR ?? join(env.HOME ?? "/tmp", ".local/share/recast"),
    host: env.RECAST_HOST?.trim() || "127.0.0.1",
    port,
    baseUrl: (env.RECAST_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
    ytDlpPath: env.YT_DLP_PATH ?? "yt-dlp",
    jsRuntime: env.RECAST_JS_RUNTIME ?? "node",
    youtubeSourceAddress,
    ffmpegPath: env.FFMPEG_PATH ?? "ffmpeg",
    whisperCliPath: env.WHISPER_CLI_PATH ?? "whisper-cli",
    whisperModel: env.WHISPER_MODEL ?? join(env.HOME ?? "/tmp", ".local/share/recast/models/ggml-large-v3-turbo.bin"),
    copilotCliPath: env.COPILOT_CLI_PATH ?? join(env.HOME ?? "/tmp", ".local/bin/copilot"),
  };
}
