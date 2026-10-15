import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PublicationInfo } from "./classify";
import { runProcess } from "./proc";
import { ChannelNotFoundError, PublicationUnavailableError, type AudioDownloader, type ChannelResolver, type MetadataLookup, type ResolvedChannel } from "./deps";
import { formatProgress, parseProgressLine, PROGRESS_TEMPLATE } from "./progress";

export interface YtDlpOptions {
  dataDir: string;
  /** The yt-dlp executable. */
  bin?: string;
  /** JavaScript runtime yt-dlp uses to solve YouTube challenges (`node` or `node:/path/to/node`). */
  jsRuntime?: string;
  /** Local IPv4 address used by the host's VPN bypass route. */
  sourceAddress?: string;
}

/** Reads `yt-dlp -J --flat-playlist --playlist-items 0 <channel url>`; anything that is not a channel page is not found. Pure. */
export function interpretChannel(j: any): ResolvedChannel {
  if (j?._type !== "playlist" || !j.channel_id) throw new ChannelNotFoundError();
  const thumbs: { id?: string; url?: string; width?: number; height?: number }[] = j.thumbnails ?? [];
  const avatar = thumbs.find((t) => t.id === "avatar_uncropped") ?? thumbs.find((t) => t.width && t.width === t.height);
  return {
    channelId: j.channel_id,
    name: j.channel ?? j.title,
    handle: typeof j.uploader_id === "string" && j.uploader_id.startsWith("@") ? j.uploader_id : null,
    imageUrl: avatar?.url ?? null,
  };
}

/** A pasted @handle or YouTube URL as a channel URL; null when it is neither. */
export function channelUrl(input: string): string | null {
  const text = input.trim();
  if (/^@[\w.-]+$/.test(text)) return `https://www.youtube.com/${text}`;
  try {
    const url = new URL(text);
    return url.hostname.replace(/^(www|m)\./, "") === "youtube.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The real YouTube adapters: metadata lookup, audio download and channel resolution, all through yt-dlp. */
export function createYtDlp({ dataDir, bin = "yt-dlp", jsRuntime = "node", sourceAddress }: YtDlpOptions): {
  metadata: MetadataLookup;
  downloader: AudioDownloader;
  resolver: ChannelResolver;
} {
  const common = ["--js-runtimes", jsRuntime, "--no-warnings", "--no-update", "--no-playlist"];
  if (sourceAddress) common.push("--source-address", sourceAddress);
  const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

  const run = (args: string[], signal: AbortSignal | undefined, onOut: (line: string) => void, onErr: (line: string) => void) =>
    runProcess(bin, args, signal, onOut, onErr);

  const failure = (code: number, stderr: string[]) =>
    new Error(stderr.filter((l) => l.startsWith("ERROR:")).at(-1)?.replace(/^ERROR:\s*/, "") ?? `yt-dlp exited with code ${code}`);

  return {
    metadata: {
      async lookup(youtubeId, signal) {
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(
          [...common, "-J", "--no-download", "--ignore-no-formats-error", watchUrl(youtubeId)],
          signal,
          (l) => out.push(l),
          (l) => err.push(l),
        );
        if (code !== 0) {
          const error = failure(code, err);
          if (/private video|(?:this )?video is unavailable|video unavailable|has been removed|video is no longer available|not available in your country/i.test(error.message))
            throw new PublicationUnavailableError(error.message);
          throw error;
        }
        const j = JSON.parse(out.join("\n"));
        return {
          channel_id: j.channel_id,
          channel: j.channel,
          title: j.title,
          duration: j.duration,
          availability: j.availability,
          media_type: j.media_type,
          live_status: j.live_status,
          was_live: j.was_live,
          timestamp: j.timestamp,
          upload_date: j.upload_date,
        } satisfies PublicationInfo;
      },
    },
    resolver: {
      async resolve(input) {
        const url = channelUrl(input);
        if (!url) throw new ChannelNotFoundError();
        const out: string[] = [];
        const err: string[] = [];
        const code = await run(
          [...common.filter((a) => a !== "--no-playlist"), "-J", "--flat-playlist", "--playlist-items", "0", url],
          undefined,
          (l) => out.push(l),
          (l) => err.push(l),
        );
        if (code !== 0) {
          if (err.some((l) => /HTTP Error 404|does not exist|not found/i.test(l))) throw new ChannelNotFoundError();
          throw failure(code, err);
        }
        return interpretChannel(JSON.parse(out.join("\n")));
      },
    },
    downloader: {
      async download(youtubeId, ctx) {
        const dir = join(dataDir, "audio");
        mkdirSync(dir, { recursive: true });
        let audioPath = join(dir, `${youtubeId}.opus`);
        const err: string[] = [];
        const code = await run(
          [
            ...common,
            "-f", "bestaudio/best",
            "-x", "--audio-format", "opus",
            "--newline", "--progress",
            "--progress-template", PROGRESS_TEMPLATE,
            "-o", join(dir, "%(id)s.%(ext)s"),
            "--print", "after_move:RECAST_FILE %(filepath)s",
            watchUrl(youtubeId),
          ],
          ctx.signal,
          (line) => {
            const progress = parseProgressLine(line);
            if (progress) return ctx.onProgress({ percent: progress.percent, detail: formatProgress(progress) });
            if (line.startsWith("RECAST_FILE ")) audioPath = line.slice("RECAST_FILE ".length);
            if (line) ctx.log(line);
          },
          (line) => {
            err.push(line);
            if (line) ctx.log(line);
          },
        );
        if (code !== 0) throw failure(code, err);
        return { audioPath };
      },
    },
  };
}
