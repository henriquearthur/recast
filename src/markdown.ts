export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const TAGS = ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "a", "strong", "em", "code", "blockquote", "timecode"] as const;

export interface MarkdownOptions {
  /** Inline `style` per tag, for places where a stylesheet does not reach (e-mail). `timecode` styles the time mark of a heading. */
  styles?: Partial<Record<(typeof TAGS)[number], string>>;
  /** Where the time mark that ends a heading (`## Title [12:34]`) links to; without it the mark is plain text. */
  timecodeHref?: (seconds: number) => string;
}

const TIMECODE = /\s*[[(]((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]\s*$/;

/** Splits the time mark that ends a heading (`Title [12:34]`) from its text. */
export function splitTimecode(heading: string): { title: string; timecode: string | null; seconds: number | null } {
  const match = heading.match(TIMECODE);
  if (!match) return { title: heading.trim(), timecode: null, seconds: null };
  const seconds = match[1]!.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  return { title: heading.slice(0, match.index).trim(), timecode: match[1]!, seconds };
}

/** Minimal Markdown to HTML: headings, lists, quotes, paragraphs, bold, italic, code and links. Input is escaped first. */
export function markdownToHtml(markdown: string, { styles = {}, timecodeHref }: MarkdownOptions = {}): string {
  const open = (tag: Exclude<(typeof TAGS)[number], "timecode">, attrs = "") => `<${tag}${attrs}${styles[tag] ? ` style="${styles[tag]}"` : ""}>`;
  const inline = (text: string) =>
    escapeHtml(text)
      .replace(/`([^`]+)`/g, `${open("code")}$1</code>`)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `${open("a", ' href="$2"')}$1</a>`)
      .replace(/\*\*([^*]+)\*\*/g, `${open("strong")}$1</strong>`)
      .replace(/\*([^*]+)\*/g, `${open("em")}$1</em>`);

  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let paragraph: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (paragraph.length) out.push(`${open("p")}${paragraph.join("<br>")}</p>`);
    if (quote.length) out.push(`${open("blockquote")}${quote.join("<br>")}</blockquote>`);
    paragraph = [];
    quote = [];
  };
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.*)$/);
    const quoted = line.match(/^>\s?(.*)$/);
    if (heading) {
      flush();
      closeList();
      const tag = `h${heading[1]!.length}` as "h1";
      const { title, timecode, seconds } = timecodeHref ? splitTimecode(heading[2]!) : { title: heading[2]!, timecode: null, seconds: null };
      const mark = timecode
        ? ` <a class="timecode" href="${escapeHtml(timecodeHref!(seconds!))}"${styles.timecode ? ` style="${styles.timecode}"` : ""}>${timecode}</a>`
        : "";
      out.push(`${open(tag)}${inline(title)}${mark}</${tag}>`);
    } else if (item) {
      flush();
      const kind = item[1] ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(open(kind));
      }
      list = kind;
      out.push(`${open("li")}${inline(item[2]!)}</li>`);
    } else if (quoted) {
      if (paragraph.length) flush();
      closeList();
      quote.push(inline(quoted[1]!.trim()));
    } else if (line.trim() === "") {
      flush();
      closeList();
    } else {
      if (quote.length) flush();
      closeList();
      paragraph.push(inline(line.trim()));
    }
  }
  flush();
  closeList();
  return out.join("\n");
}
