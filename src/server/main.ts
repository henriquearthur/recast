import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createApp } from "./app";
import { systemClock } from "./clock";
import { loadConfig } from "./config";
import { createCopilotAdapter } from "./copilot";
import { createRssFeed } from "./feed";
import { createHealthCheck, realProbes } from "./health";
import { createSmtpMailer } from "./smtp";
import { createWhisperTranscriber } from "./whisper";
import { createYtDlp } from "./ytdlp";
import index from "../web/index.html";

const config = loadConfig(process.env);
const generation = { copilot: createCopilotAdapter({ cliPath: config.copilotCliPath, dataDir: config.dataDir }), claude: createClaudeAdapter({ dataDir: config.dataDir }), codex: createCodexAdapter({ dataDir: config.dataDir }) };
const app = createApp({
  dataDir: config.dataDir,
  clock: systemClock,
  baseUrl: config.baseUrl,
  generation,
  health: createHealthCheck(realProbes(config.copilotCliPath, config.dataDir), {
    ytDlp: config.ytDlpPath,
    ffmpeg: config.ffmpegPath,
    whisperCli: config.whisperCliPath,
    whisperModel: config.whisperModel,
    env: process.env,
    checkCopilot: false,
  }),
  deps: {
    feed: createRssFeed(fetch, { sourceAddress: config.youtubeSourceAddress }),
    ...createYtDlp({ dataDir: config.dataDir, bin: config.ytDlpPath, jsRuntime: config.jsRuntime, sourceAddress: config.youtubeSourceAddress }),
    transcriber: createWhisperTranscriber({
      dataDir: config.dataDir,
      modelPath: config.whisperModel,
      whisperBin: config.whisperCliPath,
      ffmpegBin: config.ffmpegPath,
    }),
    writer: generation.copilot.writer,
    mailer: createSmtpMailer(process.env),
  },
});
app.start();

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0,
  routes: {
    "/": index,
    "/api/*": (req) => app.fetch(req),
  },
});
console.log(`Recast listening on http://${server.hostname}:${server.port} (data in ${config.dataDir})`);
