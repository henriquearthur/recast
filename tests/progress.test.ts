import { describe, expect, test } from "bun:test";
import { formatProgress, parseProgressLine } from "../src/server/progress";

const raw = await Bun.file(`${import.meta.dir}/fixtures/ytdlp/download-progress-raw.txt`).text();
const lines = raw.split("\n");

describe("downloader progress parsing against a recorded real download", () => {
  test("parses the first and a middle line", () => {
    expect(parseProgressLine(lines[2]!)).toEqual({
      percent: (1024 / 252182) * 100,
      speed: 6420.604836045356,
      eta: 39,
    });
    expect(parseProgressLine("RECAST_PROGRESS downloading|31744|252182|NA| 12.6%|143679.57863885103|1|NA|NA")).toMatchObject({ eta: 1 });
  });

  test("the finished line has no eta", () => {
    const finished = lines.find((l) => l.includes("finished|252182"))!;
    expect(parseProgressLine(finished)).toEqual({ percent: 100, speed: 149039.01773076376, eta: null });
  });

  test("uses the estimated total when the exact one is missing", () => {
    expect(parseProgressLine("RECAST_PROGRESS downloading|500|NA|1000|50%|10.0|50|NA|NA")).toMatchObject({ percent: 50 });
  });

  test("ignores everything that is not a progress line", () => {
    expect(parseProgressLine("RECAST_FILE /tmp/x.opus")).toBeNull();
    expect(parseProgressLine("RECAST_PROGRESS downloading|NA|NA|NA|NA|NA|NA|NA|NA")).toBeNull();
    expect(parseProgressLine("")).toBeNull();
  });

  test("every recorded line is understood, with non-decreasing percent", () => {
    const parsed = lines.filter((l) => l.startsWith("RECAST_PROGRESS")).map(parseProgressLine);
    expect(parsed.every((p) => p !== null)).toBe(true);
    const percents = parsed.map((p) => p!.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  test("formats speed and time left for the UI", () => {
    expect(formatProgress({ percent: 12.6, speed: 143679.5, eta: 75 })).toBe("140,3 KiB/s · faltam 1:15");
    expect(formatProgress({ percent: 100, speed: null, eta: null })).toBeUndefined();
    expect(formatProgress({ percent: 3, speed: 5_242_880, eta: 7 })).toBe("5,0 MiB/s · faltam 0:07");
  });
});
