import type { TranscriptSegment } from "./deps";

export type WhisperEvent =
  | { kind: "progress"; percent: number }
  | { kind: "duration"; seconds: number }
  | { kind: "language"; language: string }
  | { kind: "error"; message: string };

/** Reads one stderr line of `whisper-cli --print-progress`; null for anything else. */
export function parseWhisperLine(line: string): WhisperEvent | null {
  let m = line.match(/progress\s*=\s*(\d+)%/);
  if (m) return { kind: "progress", percent: Number(m[1]) };
  m = line.match(/^main: processing .*\(\d+ samples, ([\d.]+) sec\)/);
  if (m) return { kind: "duration", seconds: Number(m[1]) };
  m = line.match(/auto-detected language: (\w+) \(p = [\d.]+\)/);
  if (m) return { kind: "language", language: m[1]! };
  m = line.match(/^error: (.+)$/);
  if (m) return { kind: "error", message: m[1]! };
  return null;
}

/** Reads the `-oj` file whisper-cli writes: the detected language and the segments with their times. */
export function parseWhisperOutput(json: string): { language: string; segments: TranscriptSegment[] } {
  const j = JSON.parse(json) as {
    result: { language: string };
    transcription: { offsets: { from: number; to: number }; text: string }[];
  };
  return {
    language: j.result.language,
    segments: j.transcription.map((s) => ({ startMs: s.offsets.from, endMs: s.offsets.to, text: s.text.trim() })),
  };
}

/** Elapsed time and speed (audio seconds per second) as shown next to the percentage. */
export function formatTranscriptionProgress({ elapsedSec, speed }: { elapsedSec: number; speed: number | null }): string {
  const s = Math.floor(elapsedSec);
  const elapsed = `elapsed ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  return speed === null ? elapsed : `${elapsed} · ${speed.toFixed(1)}x audio speed`;
}
