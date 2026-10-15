/** Extracts the 11-character YouTube id from a watch or youtu.be URL; null when it is not one. */
export function parseYoutubeId(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^(www|m)\./, "");
  const candidate =
    host === "youtu.be" ? url.pathname.slice(1) : host === "youtube.com" && url.pathname === "/watch" ? url.searchParams.get("v") : null;
  return candidate && /^[\w-]{11}$/.test(candidate) ? candidate : null;
}
