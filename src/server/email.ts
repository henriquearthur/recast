import { humanDuration, parseArticle, readingMinutes } from "../article";
import { languageName, translate, type Locale } from "../i18n";
import { escapeHtml, markdownToHtml } from "../markdown";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const SERIF = "Georgia,'Times New Roman',serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const INK = "#11150f";
const SOFT = "#4c5347";
const MUTED = "#7c8377";
const LINE = "#e2e5dc";
const PINE = "#0b5d45";
const MARKER = "#d9f65a";

const label = (text: string) =>
  `<p style="margin:0 0 10px;font:700 11px/1 ${SANS};letter-spacing:.14em;text-transform:uppercase;color:${MUTED}">${text}</p>`;

const button = (href: string, text: string, primary: boolean) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 18px;border-radius:999px;font:600 14px/1 ${SANS};text-decoration:none;${
    primary ? `background:${INK};color:#ffffff;border:1px solid ${INK}` : `background:#ffffff;color:${INK};border:1px solid #c9cec2`
  }">${text}</a>`;

/**
 * Subject identifies the channel and the video. The body opens with what the Video is (title, channel, publication
 * date, length, reading time), then the Article with its parts named: the summary, an index of the sections and the text.
 */
export function renderArticleEmail(input: {
  markdown: string;
  title: string | null;
  channelName: string | null;
  youtubeId: string;
  durationSeconds: number | null;
  publishedAt: number | null;
  /** Language code of the Transcript (the Video's original language). */
  language: string | null;
  model: string | null;
  videoUrl: string;
  articleUrl: string;
  /** Language of the e-mail around the Article. */
  locale: Locale;
}): { subject: string; html: string } {
  const t = (message: string, ...values: unknown[]) => translate(input.locale, message, ...values);
  const subject = [input.channelName, input.title].filter(Boolean).join(": ") || input.videoUrl;
  const article = parseArticle(input.markdown);
  const minutes = readingMinutes(article.words);
  const at = (seconds: number) => `https://www.youtube.com/watch?v=${input.youtubeId}&t=${seconds}s`;
  const prose = (markdown: string, size: number) =>
    markdownToHtml(markdown, {
      timecodeHref: at,
      styles: {
        p: `margin:0 0 16px;font:${size}px/1.65 ${SERIF};color:${INK}`,
        h1: `margin:36px 0 12px;font:700 22px/1.3 ${SANS};color:${INK}`,
        h2: `margin:36px 0 12px;font:700 20px/1.3 ${SANS};color:${INK}`,
        h3: `margin:28px 0 10px;font:700 17px/1.35 ${SANS};color:${INK}`,
        ul: `margin:0 0 16px;padding:0 0 0 22px`,
        ol: `margin:0 0 16px;padding:0 0 0 22px`,
        li: `margin:0 0 8px;font:${size}px/1.6 ${SERIF};color:${INK}`,
        a: `color:${PINE}`,
        code: `font:0.9em ${MONO};background:#f1f3ec;padding:1px 4px;border-radius:4px`,
        blockquote: `margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid ${MARKER};font:italic ${size}px/1.65 ${SERIF};color:${SOFT}`,
        timecode: `font:500 12px/1 ${MONO};color:${PINE};text-decoration:none;white-space:nowrap;border:1px solid ${LINE};border-radius:999px;padding:3px 8px;vertical-align:middle`,
      },
    });

  const facts: [string, string][] = [];
  if (input.channelName) facts.push([t("Channel"), escapeHtml(input.channelName)]);
  if (input.publishedAt != null)
    facts.push([t("Published"), new Date(input.publishedAt).toLocaleDateString(input.locale, { day: "numeric", month: "long", year: "numeric" })]);
  if (input.durationSeconds != null) facts.push([t("Duration"), humanDuration(input.durationSeconds)]);
  facts.push([t("Reading"), `${minutes} min`]);
  if (input.language) facts.push([t("Original language"), escapeHtml(languageName(input.language, input.locale))]);

  // Reading time against watching time, as two bars on the same scale.
  const watchMinutes = input.durationSeconds != null ? input.durationSeconds / 60 : null;
  const share = watchMinutes ? Math.max(4, Math.min(100, Math.round((minutes / watchMinutes) * 100))) : null;
  const bar = (percent: number, color: string) =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td width="${percent}%" height="8" bgcolor="${color}" style="height:8px;line-height:8px;font-size:0;border-radius:4px">&nbsp;</td>${percent < 100 ? `<td style="font-size:0;line-height:8px">&nbsp;</td>` : ""}</tr></table>`;
  const saved = watchMinutes !== null && watchMinutes - minutes >= 1 ? Math.round(watchMinutes - minutes) : null;
  const compression =
    share === null
      ? ""
      : `<tr><td style="padding:20px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
<tr><td width="76" style="padding:0 0 6px;font:12px/1 ${SANS};color:${MUTED}">${t("Watch")}</td><td style="padding:0 0 6px">${bar(100, "#c9cec2")}</td></tr>
<tr><td width="76" style="font:600 12px/1 ${SANS};color:${INK}">${t("Read")}</td><td>${bar(share, PINE)}</td></tr>
</table>
${saved ? `<p style="margin:12px 0 0;font:14px/1.5 ${SANS};color:${SOFT}">${t("Reading this article gives you back {0} of your day.", `<strong style="color:${INK};background:${MARKER};padding:0 4px">${humanDuration(saved * 60)}</strong>`)}</p>` : ""}
</td></tr>`;

  const index =
    article.sections.length >= 3
      ? `<tr><td style="padding:28px 32px 0">${label(t("In this article"))}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${article.sections
  .map(
    (s) =>
      `<tr><td style="padding:7px 0;border-top:1px solid ${LINE};font:15px/1.4 ${SANS};color:${INK}">${escapeHtml(s.title)}</td><td align="right" style="padding:7px 0;border-top:1px solid ${LINE};font:12px/1.4 ${MONO};white-space:nowrap">${
        s.seconds !== null ? `<a href="${escapeHtml(at(s.seconds))}" style="color:${PINE};text-decoration:none">${s.timecode}</a>` : ""
      }</td></tr>`,
  )
  .join("\n")}
</table></td></tr>`
      : "";

  const title = escapeHtml(input.title ?? input.videoUrl);
  const preheader = escapeHtml(article.summary.replace(/^\s*[-*]\s+/gm, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").slice(0, 140));
  const html = `<!doctype html>
<html lang="${input.locale}">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${title}</title></head>
<body style="margin:0;padding:0;background:#f1f3ec">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#f1f3ec"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:16px">
<tr><td style="padding:22px 32px;border-bottom:1px solid ${LINE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
<td style="font:800 17px/1 ${SANS};letter-spacing:-.02em;color:${INK}">Recast</td>
<td align="right" style="font:12px/1 ${SANS};color:${MUTED}">${t("New video, ready to read")}</td>
</tr></table></td></tr>
<tr><td style="padding:28px 32px 0">
${input.channelName ? label(escapeHtml(input.channelName)) : ""}
<h1 style="margin:0;font:800 26px/1.2 ${SANS};letter-spacing:-.02em;color:${INK}">${title}</h1>
</td></tr>
<tr><td style="padding:20px 32px 0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>
<td width="208" valign="top" style="padding:0 20px 0 0"><a href="${escapeHtml(input.videoUrl)}"><img src="https://i.ytimg.com/vi/${escapeHtml(input.youtubeId)}/mqdefault.jpg" width="188" alt="${t("Video thumbnail")}" style="display:block;width:188px;max-width:100%;height:auto;border:0;border-radius:10px"></a></td>
<td valign="top">
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
${facts.map(([name, value]) => `<tr><td style="padding:0 14px 7px 0;font:13px/1.3 ${SANS};color:${MUTED};white-space:nowrap">${name}</td><td style="padding:0 0 7px;font:600 13px/1.3 ${SANS};color:${INK}">${value}</td></tr>`).join("\n")}
</table></td>
</tr></table></td></tr>
${compression}
<tr><td style="padding:20px 32px 0">${button(input.videoUrl, t("Watch on YouTube"), true)}${button(input.articleUrl, t("Open in Recast"), false)}</td></tr>
${
  article.summary
    ? `<tr><td style="padding:20px 32px 0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr><td style="padding:22px 24px 8px;background:#f7fbe3;border-left:4px solid ${MARKER};border-radius:4px 12px 12px 4px">
${label(t("TL;DR · the essentials"))}
${prose(article.summary, 16)}
</td></tr></table></td></tr>`
    : ""
}
${index}
<tr><td style="padding:${article.summary || index ? "4px" : "24px"} 32px 8px">
${prose(article.body, 17)}
</td></tr>
<tr><td style="padding:20px 32px 26px;border-top:1px solid ${LINE}">
${button(input.videoUrl, t("Watch on YouTube"), true)}${button(input.articleUrl, t("Open in Recast"), false)}
<p style="margin:10px 0 0;font:12px/1.6 ${SANS};color:${MUTED}">${input.model ? t("Article written by {0} from the video transcript.", escapeHtml(input.model)) : t("Article written from the video transcript.")} ${t("Check the original for anything that matters to you.")}</p>
</td></tr>
</table>
</td></tr></table>
</body>
</html>`;
  return { subject, html };
}
