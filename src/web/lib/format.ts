import { t, getLocale } from "./i18n";
import { humanDuration, parseArticle, readingMinutes } from "../../article";
import type { VideoView } from "../../server/pipeline";

export { humanDuration };

const two = (n: number) => String(n).padStart(2, "0");

/** A length as a player shows it: `28:17`, `1:02:03`. */
export function clock(totalSeconds: number) {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  return h ? `${h}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

export const number = (n: number, digits = 0) => n.toLocaleString(getLocale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });
/** Compact numbers using the selected locale. */
export const compact = (n: number) => n.toLocaleString(getLocale(), { notation: "compact", maximumFractionDigits: 1 });
export const credits = (n: number) => number(n, n < 10 ? 2 : 1);

/** Round axis ticks from zero up to at least `max`, at most five of them, stepping by one of `steps`. */
export function ticks(max: number, steps: number[]) {
  const step = steps.find((s) => max / s <= 4) ?? steps.at(-1)!;
  return Array.from({ length: Math.max(1, Math.ceil(max / step)) + 1 }, (_, i) => i * step);
}

export const date = (ms: number) => new Date(ms).toLocaleDateString(getLocale(), { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "").replace(/ de /g, " ");
export const shortDate = (ms: number) => new Date(ms).toLocaleDateString(getLocale(), { day: "numeric", month: "short" }).replace(/\./g, "").replace(" de ", " ");
export const time = (ms: number) => new Date(ms).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });

/** A moment relative to now in the selected interface language. */
export function relative(ms: number, now = Date.now()) {
  const diff = ms - now;
  const abs = Math.abs(diff);
  const say = (n: number, unit: string) => t(diff < 0 ? "{0} {1} ago" : "in {0} {1}", n, unit);
  if (abs < 45_000) return t(diff < 0 ? "just now" : "shortly");
  if (abs < 3_600_000) return say(Math.round(abs / 60_000), "min");
  if (abs < 86_400_000) return say(Math.round(abs / 3_600_000), "h");
  if (abs < 7 * 86_400_000) return say(Math.round(abs / 86_400_000), Math.round(abs / 86_400_000) === 1 ? t("day") : t("days"));
  return date(ms);
}

/** How long a run took: "42 s", "3 min 05 s". */
export function elapsed(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min ${two(s % 60)} s`;
  return `${Math.floor(s / 3600)} h ${two(Math.floor((s % 3600) / 60))} min`;
}

export const thumbnail = (youtubeId: string) => `https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`;

/** Reading time of a Video's finished Article, in minutes; null while there is none. */
export function readMinutes(video: VideoView): number | null {
  return video.article?.complete ? readingMinutes(parseArticle(video.article.markdown).words) : null;
}

export const initials = (name: string) =>
  name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

/** `YYYY-MM-DD` of a moment, in the browser's time zone. */
export const dayKey = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/** Unknown cost is never formatted as zero. */
export const usd = (value: number | null | undefined) => value == null ? t("Unavailable") : new Intl.NumberFormat(getLocale(), { style: "currency", currency: "USD", minimumFractionDigits: 4, maximumFractionDigits: 6 }).format(value);
