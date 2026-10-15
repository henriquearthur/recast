import type { GenerationProvider } from "./generation";
import type { PublicationInfo } from "./classify";

export interface StageContext {
  /** Aborted when the user cancels the video; implementations should stop their work (kill processes, abort requests). */
  signal: AbortSignal;
  onProgress(progress: { percent: number; detail?: string }): void;
  log(line: string): void;
}

export interface ListedPublication {
  youtubeId: string;
  title: string;
  publishedAt: number;
  /** The feed links a Short to /shorts/<id>; this is the only thing the feed says about the kind of publication. */
  isShort: boolean;
}

export interface ResolvedChannel {
  /** The canonical YouTube channel id (`UC...`). */
  channelId: string;
  name: string;
  handle: string | null;
  imageUrl: string | null;
}

/** Raised when the pasted URL or @handle does not lead to a YouTube channel. */
export class ChannelNotFoundError extends Error {
  constructor() {
    super("Channel not found.");
  }
}

/** Turns a pasted channel URL or @handle into the channel it points to. Rejects with `ChannelNotFoundError` when there is none. */
export interface ChannelResolver {
  resolve(input: string): Promise<ResolvedChannel>;
}

export interface PublicationFeed {
  fetchFeed(channelId: string, signal?: AbortSignal): Promise<ListedPublication[]>;
}

export interface AudioDownloader {
  /** Downloads the audio into the data directory and returns where it landed (the Transcription stage reads it). */
  download(youtubeId: string, ctx: StageContext): Promise<{ audioPath: string }>;
}

/** The lookup confirmed that this publication cannot be read (private, removed or unavailable). Other publications may still work. */
export class PublicationUnavailableError extends Error {}

/** Looks up a publication's metadata without downloading it. Rejects when the lookup itself fails. */
export interface MetadataLookup {
  lookup(youtubeId: string, signal?: AbortSignal): Promise<PublicationInfo>;
}

export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface Transcriber {
  /** Transcribes in the original language (detected automatically). On success the adapter deletes the audio. */
  transcribe(audioPath: string, ctx: StageContext): Promise<{ language: string; segments: TranscriptSegment[] }>;
}

export interface ArticleInput {
  provider: GenerationProvider;
  contextWindow?: number;
  transcript: string;
  /** What Recast knows about the Video, besides its Transcript. */
  video: { youtubeId: string; url: string; title: string | null; channelName: string | null; durationSeconds: number | null };
  /** The full instructions, already assembled by Recast. */
  instructions: string;
  model: string;
}

export interface ArticleUsage {
  provider?: GenerationProvider;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  tokensKnown?: boolean;
  costUsd?: number | null;
  costKind?: "estimated" | "equivalent" | null;
  costSource?: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Only Copilot reports credits; absent telemetry is null. */
  credits: number | null;
}

export interface ArticleContext extends StageContext {
  /** Called with each piece of the article as it is written. */
  onText(delta: string): void;
}

/** Raised when the Transcript does not fit the model in a single pass. */
export class TranscriptTooLongError extends Error {
  constructor(detail?: string) {
    super(`The transcript does not fit the selected model's context window${detail ? ` (${detail})` : ""}.`);
  }
}

/**
 * Raised by a writer that failed after consuming tokens: `usage` is what it consumed, which Recast records even though
 * there is no Article. A failure that consumed nothing is any other error.
 */
export class ArticleWriteError extends Error {
  constructor(
    readonly original: Error,
    readonly usage: ArticleUsage,
  ) {
    super(original.message);
  }
}

export interface ArticleWriter {
  /** Rejects with `ArticleWriteError` when it failed (or was aborted) after consuming tokens. */
  write(input: ArticleInput, ctx: ArticleContext): Promise<{ markdown: string; usage: ArticleUsage }>;
}

export interface Mailer {
  send(message: { to: string; subject: string; html: string }, ctx: StageContext): Promise<void>;
}

/** The external dependencies of Recast: each one has a real adapter and a fake for tests. */
export interface Deps {
  feed: PublicationFeed;
  resolver: ChannelResolver;
  downloader: AudioDownloader;
  metadata: MetadataLookup;
  transcriber: Transcriber;
  writer: ArticleWriter;
  mailer: Mailer;
}
