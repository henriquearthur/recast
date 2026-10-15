import type { Clock } from "./clock";
import type { PublicationInfo } from "./classify";
import { formatProgress } from "./progress";
import { formatTranscriptionProgress } from "./whisper-progress";
import {
  ArticleWriteError,
  ChannelNotFoundError,
  TranscriptTooLongError,
  type ArticleInput,
  type Deps,
  type ListedPublication,
  type ResolvedChannel,
  type StageContext,
} from "./deps";

export interface Fakes {
  deps: Deps;
  /** Everything the fake mailer was asked to send. */
  sent: { to: string; subject: string; html: string }[];
  /** Every input the fake article writer received. */
  writes: ArticleInput[];
  /** Metadata lookups made, in order. */
  lookups: string[];
  /** What the fake metadata lookup answers for `youtubeId` (an ordinary video by default); an Error makes the lookup fail, "hang" never answers (until aborted). */
  publish(youtubeId: string, info: PublicationInfo | Error | "hang"): void;
  /** Makes `channel` known to the fake channel resolver (by its @handle or its id). */
  addChannel(channel: ResolvedChannel): void;
  /** What the fake RSS feed of `channelId` answers; an Error makes the fetch fail, "hang" never answers (until aborted). */
  setFeed(channelId: string, publications: ListedPublication[] | Error | "hang"): void;
  /** Feed fetches made, in order. */
  feedFetches: string[];
  /**
   * Makes the next `times` runs of `stage` fail (after their simulated duration) with `message`. For the article stage,
   * `consumed` makes the failure report the tokens used before it, like a writer that fails halfway.
   */
  fail(stage: "download" | "transcription" | "article" | "delivery", times?: number, message?: string, opts?: { consumed?: boolean }): void;
  /** How many runs of `stage` are alive right now (a cancelled one counts until it really stops). */
  running(stage: string): number;
  /** The most runs of `stage` that were ever alive at the same time. */
  mostRunningAtOnce(stage: string): number;
}

/** Fake dependencies that simulate duration and progress through the injected clock. */
export function createFakes(clock: Clock, opts: {
    tickMs?: number;
    maxTranscriptChars?: number;
    /** How long a stage keeps running after its signal is aborted before it stops (a process taking time to die). */
    abortLingerMs?: number;
    /** The writer carries on and returns normally after its signal is aborted. */
    writerIgnoresAbort?: boolean;
  } = {},): Fakes {
  const tickMs = opts.tickMs ?? 1000;
  const sent: Fakes["sent"] = [];
  const writes: ArticleInput[] = [];

  const lookups: string[] = [];
  const published = new Map<string, PublicationInfo | Error | "hang">();

  const channels: ResolvedChannel[] = [];
  const feeds = new Map<string, ListedPublication[] | Error | "hang">();
  const feedFetches: string[] = [];

  /** Never settles on its own; rejects when the caller gives up through `signal`. */
  const hang = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));

  const failures = new Map<string, { times: number; message: string; consumed: boolean }>();
  const alive = new Map<string, number>();
  const peak = new Map<string, number>();
  const enter = (what: string) => {
    const n = (alive.get(what) ?? 0) + 1;
    alive.set(what, n);
    peak.set(what, Math.max(peak.get(what) ?? 0, n));
  };
  const leave = (what: string) => alive.set(what, (alive.get(what) ?? 1) - 1);

  /** A stage that stops when aborted, after `abortLingerMs`. */
  async function stopIfAborted(ctx: StageContext) {
    if (!ctx.signal.aborted) return;
    await clock.sleep(opts.abortLingerMs ?? 0);
    throw new Error("cancelled");
  }

  async function simulate(ticks: number, ctx: StageContext, what: string) {
    enter(what);
    try {
      await simulateRun(ticks, ctx, what);
    } finally {
      leave(what);
    }
  }

  async function simulateRun(ticks: number, ctx: StageContext, what: string) {
    for (let i = 1; i <= ticks; i++) {
      await clock.sleep(tickMs);
      await stopIfAborted(ctx);
      ctx.onProgress({
        percent: Math.round((i / ticks) * 100),
        detail:
          what === "download"
            ? formatProgress({ percent: 0, speed: 140_000 * i, eta: ticks - i })
            : what === "transcription"
              ? formatTranscriptionProgress({ elapsedSec: (i * tickMs) / 1000, speed: 2.5 * i })
              : undefined,
      });
      ctx.log(`${what}: ${i}/${ticks}`);
    }
    const failure = failures.get(what);
    if (failure && failure.times > 0) {
      failure.times--;
      throw new Error(failure.message);
    }
  }

  const deps: Deps = {
    feed: {
      async fetchFeed(channelId, signal) {
        feedFetches.push(channelId);
        const feed = feeds.get(channelId) ?? [];
        if (feed === "hang") return hang(signal);
        if (feed instanceof Error) throw feed;
        return feed;
      },
    },
    resolver: {
      async resolve(input) {
        const text = input.trim();
        const found = channels.find(
          (c) => [c.handle, c.channelId].some((k) => k && (text === k || text.endsWith(`/${k}`))) || text.endsWith(`/channel/${c.channelId}`),
        );
        if (!found) throw new ChannelNotFoundError();
        return found;
      },
    },
    metadata: {
      async lookup(youtubeId, signal) {
        lookups.push(youtubeId);
        const info = published.get(youtubeId);
        if (info === "hang") return hang(signal);
        if (info instanceof Error) throw info;
        return {
          channel_id: "UCfake",
          channel: "Fake Channel",
          title: "Fake video",
          duration: 19,
          availability: "public",
          media_type: "video",
          live_status: "not_live",
          was_live: false,
          ...info,
        };
      },
    },
    downloader: {
      async download(youtubeId, ctx) {
        await simulate(4, ctx, "download");
        return { audioPath: `/fake/${youtubeId}.m4a` };
      },
    },
    transcriber: {
      async transcribe(_audioPath, ctx) {
        await simulate(4, ctx, "transcription");
        return { language: "en", segments: [{ startMs: 0, endMs: 4000, text: "fake transcript text" }] };
      },
    },
    writer: {
      async write(input, ctx) {
        writes.push(input);
        if (opts.maxTranscriptChars !== undefined && input.transcript.length > opts.maxTranscriptChars) {
          throw new TranscriptTooLongError();
        }
        enter("article");
        try {
          const pieces = ["- fake summary\n\n", "## Section\n\n", `Fake article about ${input.video.url}`];
          for (const [i, piece] of pieces.entries()) {
            await clock.sleep(tickMs);
            if (!opts.writerIgnoresAbort) await stopIfAborted(ctx);
            ctx.onText(piece);
            ctx.onProgress({ percent: Math.round(((i + 1) / pieces.length) * 100) });
            ctx.log(`article: ${i + 1}/${pieces.length}`);
          }
          const failure = failures.get("article");
          if (failure && failure.times > 0) {
            failure.times--;
            const error = new Error(failure.message);
            throw failure.consumed ? new ArticleWriteError(error, { provider: input.provider, model: input.model, inputTokens: 1200, outputTokens: 40, credits: input.provider === "copilot" ? 0.003 : null, costUsd: input.provider === "copilot" ? 0.00003 : 0.01 }) : error;
          }
          const usage = { provider: input.provider, model: input.model, inputTokens: 1200, outputTokens: 300, credits: input.provider === "copilot" ? 0.027 : null, costUsd: input.provider === "copilot" ? 0.00027 : 0.06 };
          return { markdown: pieces.join(""), usage };
        } finally {
          leave("article");
        }
      },
    },
    mailer: {
      async send(message, ctx) {
        await simulate(1, ctx, "delivery");
        sent.push(message);
      },
    },
  };
  return {
    deps,
    sent,
    writes,
    lookups,
    feedFetches,
    addChannel: (channel) => void channels.push(channel),
    setFeed: (channelId, publications) => void feeds.set(channelId, publications),
    publish: (youtubeId, info) => void published.set(youtubeId, info),
    fail: (stage, times = 1, message = `simulated failure in ${stage}`, { consumed = false } = {}) =>
      void failures.set(stage, { times, message, consumed }),
    running: (stage) => alive.get(stage) ?? 0,
    mostRunningAtOnce: (stage) => peak.get(stage) ?? 0,
  };
}
