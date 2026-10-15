import type { ListedPublication, PublicationFeed } from "./deps";
import { runProcess } from "./proc";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s: string) =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec, hex, name) =>
    dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16)) : (ENTITIES[name] ?? m),
  );

/** Reads the entries of a YouTube channel Atom feed, in feed order (newest first). Pure. */
export function parseFeed(xml: string): ListedPublication[] {
  const publications: ListedPublication[] = [];
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const youtubeId = entry!.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entry!.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
    const published = entry!.match(/<published>([^<]+)<\/published>/)?.[1];
    const link = entry!.match(/<link rel="alternate" href="([^"]+)"/)?.[1] ?? "";
    const publishedAt = published ? Date.parse(published) : NaN;
    if (!youtubeId || Number.isNaN(publishedAt)) continue;
    publications.push({ youtubeId, title: decode(title), publishedAt, isShort: link.includes("/shorts/") });
  }
  return publications;
}

/** The real feed source: the public RSS feed of the channel. */
export function createRssFeed(fetchImpl: typeof fetch = fetch, options: { sourceAddress?: string; curlBin?: string } = {}): PublicationFeed {
  return {
    async fetchFeed(channelId, signal) {
      const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
      if (options.sourceAddress) {
        // Bind RSS to the same source-based VPN bypass as yt-dlp; Bun fetch does not expose a local address.
        const out: string[] = [];
        const err: string[] = [];
        const code = await runProcess(options.curlBin ?? "curl", ["--ipv4", "--interface", options.sourceAddress, "--fail", "--silent", "--show-error", url], signal, (line) => out.push(line), (line) => err.push(line));
        if (code !== 0) throw new Error(err.join("\n") || `curl exited with code ${code}`);
        return parseFeed(out.join("\n"));
      }
      const res = await fetchImpl(url, { signal });
      if (!res.ok) throw new Error(`The channel feed returned HTTP ${res.status}`);
      return parseFeed(await res.text());
    },
  };
}
