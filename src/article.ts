import { splitTimecode } from "./markdown";

export interface ArticleParts {
  /** The short summary that opens the Article (Markdown, without its heading); empty when the Article has none. */
  summary: string;
  /** Everything after the summary (Markdown). */
  body: string;
  /** The sections of the body, in order, each with the moment of the Video it starts at when the Article says so. */
  sections: { title: string; timecode: string | null; seconds: number | null }[];
  words: number;
}

const SUMMARY_TITLE = /^(tl;?dr|resumo|em resumo)\b/i;
const WORDS_PER_MINUTE = 200;

/**
 * Reads the shape every Article has: a summary first, then sections. The summary is either the text before the first
 * heading or a first section titled "TL;DR"/"Resumo". Works on a partial text too, while the Article is being written.
 */
export function parseArticle(markdown: string): ArticleParts {
  const lines = markdown.split("\n");
  const isHeading = (line: string) => /^#{1,6}\s/.test(line);
  const first = lines.findIndex(isHeading);
  let summary: string[] = [];
  let body = lines;
  if (first === -1) {
    // No heading yet: a text that opens with a list is the summary still being written.
    if (/^\s*[-*]\s/.test(lines.find((l) => l.trim()) ?? "")) [summary, body] = [lines, []];
  } else if (lines.slice(0, first).some((l) => l.trim())) {
    [summary, body] = [lines.slice(0, first), lines.slice(first)];
  } else if (SUMMARY_TITLE.test(lines[first]!.replace(/^#+\s+/, ""))) {
    const next = lines.findIndex((l, i) => i > first && isHeading(l));
    [summary, body] = [lines.slice(first + 1, next === -1 ? undefined : next), next === -1 ? [] : lines.slice(next)];
  }
  const level = Math.min(...body.filter(isHeading).map((l) => l.match(/^#+/)![0].length));
  return {
    summary: summary.join("\n").trim(),
    body: body.join("\n").trim(),
    sections: body.filter((l) => isHeading(l) && l.match(/^#+/)![0].length === level).map((l) => splitTimecode(l.replace(/^#+\s+/, ""))),
    words: markdown.replace(/[#*_`>\[\]()-]/g, " ").split(/\s+/).filter(Boolean).length,
  };
}

/** How long the Article takes to read, in whole minutes. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / WORDS_PER_MINUTE));

/** "28 min", "1 h 12 min": the length of a Video the way a person says it. */
export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ""}` : `${m} min`;
}
