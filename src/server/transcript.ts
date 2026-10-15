import type { TranscriptSegment } from "./deps";

const two = (n: number) => String(n).padStart(2, "0");

/** The Transcript as plain text, one `[mm:ss]` line per segment; this is what the Article stage reads. */
export function formatTranscript(segments: TranscriptSegment[]): string {
  return segments
    .map(({ startMs, text }) => {
      const s = Math.floor(startMs / 1000);
      const h = Math.floor(s / 3600);
      const clock = h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${two(Math.floor(s / 60))}:${two(s % 60)}`;
      return `[${clock}] ${text}`;
    })
    .join("\n");
}
