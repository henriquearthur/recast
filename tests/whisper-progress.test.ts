import { describe, expect, test } from "bun:test";
import { formatTranscriptionProgress, parseWhisperLine, parseWhisperOutput } from "../src/server/whisper-progress";

const fixture = (name: string) => Bun.file(`${import.meta.dir}/fixtures/whisper/${name}`).text();

describe("whisper-cli progress parser (recorded real output)", () => {
  test("reads the progress percentages of a real run, in order", async () => {
    const events = (await fixture("whisper.stderr.txt")).split("\n").map(parseWhisperLine);
    expect(events.filter((e) => e?.kind === "progress").map((e) => (e as { percent: number }).percent)).toEqual([
      23, 44, 48, 64, 86, 100,
    ]);
  });

  test("reads the audio duration and the detected language", async () => {
    const events = (await fixture("whisper.stderr.txt")).split("\n").map(parseWhisperLine);
    expect(events.find((e) => e?.kind === "duration")).toEqual({ kind: "duration", seconds: 120 });
    expect(events.find((e) => e?.kind === "language")).toEqual({ kind: "language", language: "pt" });
  });

  test("ignores everything else", async () => {
    const events = (await fixture("whisper.stderr.txt")).split("\n").map(parseWhisperLine);
    expect(events.filter(Boolean)).toHaveLength(8);
  });

  test("a line starting with error: is an error; the usage text is not", async () => {
    const lines = (await fixture("fail-corrupt-wav.stderr.txt")).split("\n").map(parseWhisperLine);
    expect(lines.filter((e) => e?.kind === "error")).toEqual([
      { kind: "error", message: "failed to read audio file 'bad.wav'" },
    ]);
  });

  test("parses the real JSON output into language and trimmed segments", async () => {
    const out = parseWhisperOutput(await fixture("transcript.json"));
    expect(out.language).toBe("pt");
    expect(out.segments).toHaveLength(32);
    expect(out.segments[0]).toEqual({
      startMs: 0,
      endMs: 4900,
      text: expect.stringMatching(/^conseguiu entender o que eles precisavam/),
    });
  });
});

describe("progress text", () => {
  test("shows elapsed time and speed relative to the audio duration", () => {
    expect(formatTranscriptionProgress({ elapsedSec: 83, speed: 4.64 })).toBe("elapsed 1:23 · 4.6x audio speed");
  });
  test("shows only the elapsed time while there is no speed yet", () => {
    expect(formatTranscriptionProgress({ elapsedSec: 5, speed: null })).toBe("elapsed 0:05");
  });
});
