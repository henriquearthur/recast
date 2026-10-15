import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Transcriber } from "./deps";
import { runProcess } from "./proc";
import { formatTranscriptionProgress, parseWhisperLine, parseWhisperOutput } from "./whisper-progress";

export interface WhisperOptions {
  dataDir: string;
  /** The ggml model file (large-v3-turbo). */
  modelPath: string;
  whisperBin?: string;
  ffmpegBin?: string;
}

/** The real transcriber: ffmpeg to a 16 kHz mono WAV, then whisper-cli on the GPU with automatic language detection. */
export function createWhisperTranscriber({
  dataDir,
  modelPath,
  whisperBin = "whisper-cli",
  ffmpegBin = "ffmpeg",
}: WhisperOptions): Transcriber {
  return {
    async transcribe(audioPath, ctx) {
      if (!existsSync(modelPath)) throw new Error(`Whisper model not found: ${modelPath}`);
      // Temporary files live in the data directory, never in the repository.
      const tmpRoot = join(dataDir, "tmp");
      mkdirSync(tmpRoot, { recursive: true });
      const work = mkdtempSync(join(tmpRoot, "transcribe-"));
      try {
        const wav = join(work, "audio.wav");
        const ffmpegErr: string[] = [];
        const ffmpegCode = await runProcess(
          ffmpegBin,
          ["-nostdin", "-y", "-hide_banner", "-i", audioPath, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav],
          ctx.signal,
          () => {},
          (l) => l && ffmpegErr.push(l),
        );
        if (ffmpegCode !== 0) throw new Error(ffmpegErr.at(-1) ?? `ffmpeg exited with code ${ffmpegCode}`);

        const spawnedAt = Date.now();
        let startedAt = spawnedAt;
        let audioSec: number | null = null;
        const errors: string[] = [];
        const onErr = (line: string) => {
          if (line) ctx.log(line);
          const event = parseWhisperLine(line);
          if (event?.kind === "duration") {
            audioSec = event.seconds;
            startedAt = Date.now(); // the model is loaded by now: speed counts transcription time only
          } else if (event?.kind === "error") errors.push(event.message);
          else if (event?.kind === "progress") {
            const now = Date.now();
            const done = audioSec === null ? 0 : (audioSec * event.percent) / 100;
            const working = (now - startedAt) / 1000;
            ctx.onProgress({
              percent: event.percent,
              detail: formatTranscriptionProgress({
                elapsedSec: (now - spawnedAt) / 1000,
                speed: done > 0 && working > 0 ? done / working : null,
              }),
            });
          }
        };
        const out = join(work, "transcript");
        const code = await runProcess(
          whisperBin,
          ["-m", modelPath, "-f", wav, "-l", "auto", "--print-progress", "-oj", "-of", out],
          ctx.signal,
          (l) => l && ctx.log(l),
          onErr,
        );
        // Exit code 0 is not enough: whisper-cli reports some failures only on stderr or by not writing the file.
        if (errors.length) throw new Error(errors.at(-1));
        if (code !== 0) throw new Error(`whisper-cli exited with code ${code}`);
        if (!existsSync(`${out}.json`)) throw new Error("whisper-cli did not produce a transcript");
        const result = parseWhisperOutput(await Bun.file(`${out}.json`).text());
        rmSync(audioPath, { force: true });
        return result;
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
  };
}
