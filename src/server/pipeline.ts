import { type GenerationProvider } from "./generation";
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { errorMessage } from "./errors";
import { ArticleWriteError, TranscriptTooLongError, type ArticleContext, type ArticleUsage, type Deps, type StageContext, type TranscriptSegment } from "./deps";
import { localeFor } from "../i18n";
import { renderArticleEmail } from "./email";
import { assembleInstructions } from "./prompt";
import { formatTranscript } from "./transcript";
import type { Settings } from "./settings";

export const STAGES = ["download", "transcription", "article", "delivery"] as const;
export type Stage = (typeof STAGES)[number];

export const MAX_ATTEMPTS = 3;
/** Wait before the next attempt, after `attempt` failed: 30s, then 60s. */
const backoffMs = (attempt: number) => 30_000 * 2 ** (attempt - 1);

/** What a command on one video answers: its new state, or why nothing was done. */
export type Outcome<T> = T | "not_found" | "conflict";

export type LogEntry = { videoId: number; stage: Stage; attempt: number; line: string };

export type VideoView = {
  id: number;
  youtubeId: string;
  url: string;
  state: "in_progress" | "completed" | "failed" | "cancelled";
  createdAt: number;
  /** When YouTube published it; null when unknown. */
  publishedAt: number | null;
  title: string | null;
  /** The source channel's name; for an ad hoc video this is not a Channel. */
  channelName: string | null;
  /** `ad_hoc` for a video requested by hand; stays so, and `channel` stays too if the Channel is removed. */
  origin: "channel" | "ad_hoc";
  /** The followed Channel, if it still exists. */
  channelId: number | null;
  durationSeconds: number | null;
  stages: {
    stage: Stage;
    status: "waiting" | "running" | "done" | "failed" | "cancelled";
    /** Number of the latest attempt of this stage (0 when it has not been queued yet). */
    attempts: number;
    /** When a waiting retry becomes eligible to run; null otherwise. */
    retryAt: number | null;
    /** 1-based place in the stage's FIFO queue while a run is waiting; null otherwise. */
    queuePosition: number | null;
    percent: number | null;
    detail: string | null;
    startedAt: number | null;
    finishedAt: number | null;
    error: string | null;
  }[];
  article: {
    markdown: string;
    complete: boolean;
    usage: ArticleUsage | null;
    /** While an Article is being regenerated: the new text so far; the previous Article stays in `markdown` until it is complete. */
    draft: string | null;
  } | null;
};

export type ArticleChunk = { id: number; offset: number; delta: string };

type VideoRow = {
  id: number;
  youtube_id: string;
  url: string;
  state: VideoView["state"];
  created_at: number;
  published_at: number | null;
  title: string | null;
  channel_name: string | null;
  duration_seconds: number | null;
  origin: VideoView["origin"];
  channel_id: number | null;
};
type RunRow = {
  id: number;
  video_id: number;
  stage: Stage;
  attempt: number;
  not_before: number | null;
  queued_at: number;
  log: string;
  status: VideoView["stages"][number]["status"];
  percent: number | null;
  detail: string | null;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  output: string | null;
  model: string | null;
  provider: GenerationProvider | null;
};

/**
 * Per-video state machine plus one FIFO queue and one executor per stage.
 * All state lives in SQLite; the only in-memory piece is "which stage executors are busy".
 */
export class Pipeline {
  private running = new Map<Stage, { runId: number; controller: AbortController }>();
  private scheduledPumps = new Set<number>();
  private listeners = new Set<(video: VideoView) => void>();
  private chunkListeners = new Set<(chunk: ArticleChunk) => void>();
  private logListeners = new Set<(entry: LogEntry) => void>();

  constructor(
    private db: Database,
    private deps: Deps,
    private clock: Clock,
    private baseUrl: string,
    private settings: Settings,
  ) {}

  subscribeChunks(listener: (chunk: ArticleChunk) => void): () => void {
    this.chunkListeners.add(listener);
    return () => this.chunkListeners.delete(listener);
  }

  subscribe(listener: (video: VideoView) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLogs(listener: (entry: LogEntry) => void): () => void {
    this.logListeners.add(listener);
    return () => this.logListeners.delete(listener);
  }

  /** Creates the video (or returns the existing one) and queues it for download. */
  request(
    youtubeId: string,
    url: string,
    meta: { title?: string | null; channelName?: string | null; durationSeconds?: number | null; channelId?: number | null; publishedAt?: number | null } = {},
  ): { video: VideoView; created: boolean } {
    const existing = this.db.query<VideoRow, [string]>("SELECT * FROM videos WHERE youtube_id = ?").get(youtubeId);
    if (existing) return { video: this.view(existing.id)!, created: false };
    const now = this.clock.now();
    const { id } = this.db
      .query<{ id: number }, [string, string, number, string | null, string | null, number | null, number | null, string, number | null]>(
        "INSERT INTO videos (youtube_id, url, state, created_at, title, channel_name, duration_seconds, channel_id, origin, published_at) VALUES (?, ?, 'in_progress', ?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(youtubeId, url, now, meta.title ?? null, meta.channelName ?? null, meta.durationSeconds ?? null, meta.channelId ?? null, meta.channelId != null ? "channel" : "ad_hoc", meta.publishedAt ?? null)!;
    this.queue(id, STAGES[0]);
    this.pump();
    return { video: this.view(id)!, created: true };
  }

  findByYoutubeId(youtubeId: string): VideoView | null {
    const row = this.db.query<{ id: number }, [string]>("SELECT id FROM videos WHERE youtube_id = ?").get(youtubeId);
    return row ? this.view(row.id) : null;
  }

  /** Newest first. `origin: "ad_hoc"` is the group of ad hoc videos; `articleReady` keeps only videos with a finished Article. */
  list(filter: { channelId?: number; origin?: VideoView["origin"]; state?: VideoView["state"]; articleReady?: boolean } = {}): VideoView[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.origin) (where.push("origin = ?"), args.push(filter.origin));
    if (filter.channelId !== undefined) (where.push("channel_id = ?"), args.push(filter.channelId));
    if (filter.state) (where.push("state = ?"), args.push(filter.state));
    if (filter.articleReady) where.push("id IN (SELECT video_id FROM articles WHERE complete = 1)");
    const sql = `SELECT id FROM videos ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC`;
    return this.db.query<{ id: number }, (string | number)[]>(sql).all(...args).map((r) => this.view(r.id)!);
  }

  view(id: number): VideoView | null {
    const v = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(id);
    if (!v) return null;
    const runs = this.db
      .query<RunRow, [number]>("SELECT * FROM stage_runs WHERE video_id = ? ORDER BY id")
      .all(id);
    return {
      id: v.id,
      youtubeId: v.youtube_id,
      url: v.url,
      state: v.state,
      createdAt: v.created_at,
      publishedAt: v.published_at,
      title: v.title,
      channelName: v.channel_name,
      origin: v.origin,
      channelId: v.channel_id,
      durationSeconds: v.duration_seconds,
      article: this.articleOf(v.id),
      stages: STAGES.map((stage) => {
        const run = runs.filter((r) => r.stage === stage).at(-1);
        return {
          stage,
          status: run?.status ?? "waiting",
          attempts: run?.attempt ?? 0,
          retryAt: run?.status === "waiting" && run.not_before && run.not_before > this.clock.now() ? run.not_before : null,
          queuePosition:
            run?.status === "waiting"
              ? 1 + this.db.query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM stage_runs WHERE stage = ? AND status = 'waiting' AND id < ?").get(stage, run.id)!.n
              : null,
          percent: run?.percent ?? null,
          detail: run?.detail ?? null,
          startedAt: run?.started_at ?? null,
          finishedAt: run?.finished_at ?? null,
          error: run?.error ?? null,
        };
      }),
    };
  }

  private articleOf(videoId: number): VideoView["article"] {
    const a = this.db
      .query<{ markdown: string; complete: number; draft: string | null }, [number]>("SELECT markdown, complete, draft FROM articles WHERE video_id = ?")
      .get(videoId);
    if (!a) return null;
    const u = this.db
      .query<ArticleUsage, [number]>(
        `SELECT u.model, u.provider, u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
          u.cached_input_tokens AS cachedInputTokens, u.tokens_known AS tokensKnown, CASE WHEN u.credits_known THEN u.credits END AS credits,
          coalesce(u.cost_usd, CASE WHEN u.provider = 'copilot' AND u.credits_known THEN u.credits * 0.01 END) AS costUsd,
          coalesce(u.cost_kind, CASE WHEN u.provider = 'copilot' AND u.credits_known THEN 'equivalent' END) AS costKind,
          coalesce(u.cost_source, CASE WHEN u.provider = 'copilot' AND u.credits_known THEN 'Copilot AI credits · USD 0.01/credit' END) AS costSource
         FROM usage_records u JOIN articles a ON a.usage_record_id = u.id WHERE a.video_id = ?`,
      )
      .get(videoId);
    return {
      markdown: a.markdown,
      complete: a.complete === 1,
      usage: u ? { ...u, tokensKnown: Boolean(u.tokensKnown) } : null,
      draft: a.draft,
    };
  }

  /** Every attempt of every stage of a video, oldest first, with raw logs. */
  attempts(id: number) {
    if (!this.view(id)) return "not_found" as const;
    return this.db
      .query<RunRow, [number]>("SELECT * FROM stage_runs WHERE video_id = ? ORDER BY id")
      .all(id)
      .map((r) => ({
        stage: r.stage,
        attempt: r.attempt,
        status: r.status,
        queuedAt: r.queued_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        error: r.error,
        log: r.log,
      }));
  }

  /** Puts a failed video back on the stage that failed, with a fresh set of attempts. */
  retry(id: number): Outcome<VideoView> {
    return this.requeue(id, "failed");
  }

  /** Puts a cancelled video back on the stage where it stopped. */
  resume(id: number): Outcome<VideoView> {
    return this.requeue(id, "cancelled");
  }

  /** A video that ended `failed` (or `cancelled`) has its last run in that same status: put it back on that stage. */
  private requeue(id: number, endedAs: "failed" | "cancelled"): Outcome<VideoView> {
    const v = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(id);
    if (!v) return "not_found";
    if (v.state !== endedAs) return "conflict";
    const last = this.db
      .query<RunRow, [number, string]>("SELECT * FROM stage_runs WHERE video_id = ? AND status = ? ORDER BY id DESC LIMIT 1")
      .get(id, endedAs);
    if (!last) return "conflict";
    this.db.query("UPDATE videos SET state = 'in_progress' WHERE id = ?").run(id);
    this.queue(id, last.stage, 1, null, last.model, last.provider);
    this.pump();
    return this.view(id)!;
  }

  /** Regeneration uses the current global generation selection; Delivery follows. */
  regenerate(id: number): Outcome<VideoView> {
    const v = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(id);
    if (!v) return "not_found";
    if (v.state !== "completed") return "conflict";
    this.db.query("UPDATE videos SET state = 'in_progress' WHERE id = ?").run(id);
    this.queue(id, "article");
    this.pump();
    return this.view(id)!;
  }

  /**
   * Stops the running (or waiting) stage of an in-progress video, keeping what was already produced. The stage's
   * executor stays busy until the stage really ends, so the next run of that stage never overlaps the dying one.
   */
  cancel(id: number): Outcome<VideoView> {
    const v = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(id);
    if (!v) return "not_found";
    if (v.state !== "in_progress") return "conflict";
    const run = this.db
      .query<RunRow, [number]>(
        "SELECT * FROM stage_runs WHERE video_id = ? AND status IN ('waiting', 'running') ORDER BY id DESC LIMIT 1",
      )
      .get(id);
    if (run) {
      this.db.query("UPDATE stage_runs SET status = 'cancelled', finished_at = ? WHERE id = ?").run(this.clock.now(), run.id);
      const active = this.running.get(run.stage);
      if (active?.runId === run.id) active.controller.abort();
    }
    this.db.query("UPDATE videos SET state = 'cancelled' WHERE id = ?").run(id);
    this.emit(id);
    this.pump();
    return this.view(id)!;
  }

  /** Stages found running (the process died) go back to the queue, from zero, without using an attempt. */
  recover() {
    this.db.query("UPDATE stage_runs SET provider = 'copilot', model = coalesce(model, ?) WHERE stage = 'article' AND provider IS NULL AND (status = 'running' OR attempt > 1)").run(this.settings.generationModel("copilot"));
    this.db
      .query("UPDATE stage_runs SET status = 'waiting', percent = NULL, detail = NULL, started_at = NULL WHERE status = 'running'")
      .run();
  }

  /** The stored Transcript of a video, in its original language; null until the Transcription stage has finished. */
  transcript(videoId: number): { language: string; segments: TranscriptSegment[] } | null {
    const row = this.db
      .query<{ language: string; segments: string }, [number]>("SELECT language, segments FROM transcripts WHERE video_id = ?")
      .get(videoId);
    return row ? { language: row.language, segments: JSON.parse(row.segments) } : null;
  }

  /** The finished Article text; the `articles` table is the single source for the UI, the API and the e-mail. */
  article(videoId: number): string | null {
    return (
      this.db
        .query<{ markdown: string }, [number]>("SELECT markdown FROM articles WHERE video_id = ? AND complete = 1")
        .get(videoId)?.markdown ?? null
    );
  }

  /** The e-mail of a Video's Article, exactly as the Delivery stage sends it; null until the Article is finished. */
  email(videoId: number): { subject: string; html: string } | null {
    const video = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(videoId);
    const markdown = this.article(videoId);
    if (!video || markdown === null) return null;
    return renderArticleEmail({
      markdown,
      title: video.title,
      channelName: video.channel_name,
      youtubeId: video.youtube_id,
      durationSeconds: video.duration_seconds,
      publishedAt: video.published_at,
      language: this.transcript(videoId)?.language ?? null,
      model: this.articleOf(videoId)?.usage?.model ?? null,
      videoUrl: video.url,
      articleUrl: `${this.baseUrl}/#/videos/${videoId}`,
      locale: localeFor(this.settings.get("articleLanguage")),
    });
  }

  /** Starts the next due waiting run of every idle stage. Safe to call at any time. */
  pump() {
    const now = this.clock.now();
    for (const stage of STAGES) {
      if (this.running.has(stage)) continue;
      const next = this.db
        .query<RunRow, [Stage, number]>(
          "SELECT * FROM stage_runs WHERE stage = ? AND status = 'waiting' AND (not_before IS NULL OR not_before <= ?) ORDER BY id LIMIT 1",
        )
        .get(stage, now);
      if (next) void this.execute(stage, next);
    }
    // Retries waiting for their backoff need a wake-up call.
    const later = this.db
      .query<{ at: number | null }, [number]>("SELECT MIN(not_before) AS at FROM stage_runs WHERE status = 'waiting' AND not_before > ?")
      .get(now)?.at;
    if (later && !this.scheduledPumps.has(later)) {
      this.scheduledPumps.add(later);
      void this.clock.sleep(later - now).then(() => {
        this.scheduledPumps.delete(later);
        this.pump();
      });
    }
  }

  private queue(videoId: number, stage: Stage, attempt = 1, notBefore: number | null = null, model: string | null = null, provider: GenerationProvider | null = null) {
    this.db
      .query(
        "INSERT INTO stage_runs (video_id, stage, attempt, status, queued_at, not_before, model, provider) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?)",
      )
      .run(videoId, stage, attempt, this.clock.now(), notBefore, model, provider);
    this.emit(videoId);
  }

  private emit(videoId: number) {
    const view = this.view(videoId);
    if (view) for (const l of this.listeners) l(view);
  }

  private async execute(stage: Stage, run: RunRow) {
    const controller = new AbortController();
    this.running.set(stage, { runId: run.id, controller });
    this.db
      .query("UPDATE stage_runs SET status = 'running', started_at = ?, percent = 0 WHERE id = ?")
      .run(this.clock.now(), run.id);
    if (stage === "article") {
      // Legacy interrupted Article runs belong to Copilot. Fresh queued runs use current settings.
      run.provider ??= run.model ? "copilot" : this.settings.get("provider") as GenerationProvider;
      run.model ??= this.settings.generationModel(run.provider);
      this.db.query("UPDATE stage_runs SET provider = ?, model = ? WHERE id = ?").run(run.provider, run.model, run.id);
    }
    this.emit(run.video_id);

    const ctx: StageContext = {
      signal: controller.signal,
      onProgress: ({ percent, detail }) => {
        if (controller.signal.aborted) return;
        this.db.query("UPDATE stage_runs SET percent = ?, detail = ? WHERE id = ?").run(percent, detail ?? null, run.id);
        this.emit(run.video_id);
      },
      log: (line) => {
        if (controller.signal.aborted) return;
        this.db.query("UPDATE stage_runs SET log = log || ? || char(10) WHERE id = ?").run(line, run.id);
        for (const l of this.logListeners) l({ videoId: run.video_id, stage, attempt: run.attempt, line });
      },
    };

    try {
      const output = await this.runStage(stage, run.video_id, run.model, run.provider, ctx);
      // The stage ended on its own after being cancelled: what it produced is not kept as the outcome.
      controller.signal.throwIfAborted();
      this.db
        .query("UPDATE stage_runs SET status = 'done', percent = 100, finished_at = ?, output = ? WHERE id = ?")
        .run(this.clock.now(), output, run.id);
      const nextStage = STAGES[STAGES.indexOf(stage) + 1];
      if (nextStage) this.queue(run.video_id, nextStage);
      else this.db.query("UPDATE videos SET state = 'completed' WHERE id = ?").run(run.video_id);
    } catch (err) {
      // cancel() already recorded the outcome; the executor is released below, once the stage has really ended.
      if (!controller.signal.aborted) {
        const original = err instanceof ArticleWriteError ? err.original : err;
        const now = this.clock.now();
        this.db
          .query("UPDATE stage_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?")
          .run(now, errorMessage(original), run.id);
        // A transcript that does not fit the model will not fit on the next attempt either.
        if (run.attempt < MAX_ATTEMPTS && !(original instanceof TranscriptTooLongError)) this.queue(run.video_id, stage, run.attempt + 1, now + backoffMs(run.attempt), run.model, run.provider);
        else this.db.query("UPDATE videos SET state = 'failed' WHERE id = ?").run(run.video_id);
      }
    }
    this.running.delete(stage);
    this.emit(run.video_id);
    this.pump();
  }

  private previousOutput(videoId: number, stage: Stage): string {
    const prev = STAGES[STAGES.indexOf(stage) - 1]!;
    return (
      this.db
        .query<{ output: string | null }, [number, string]>(
          "SELECT output FROM stage_runs WHERE video_id = ? AND stage = ? AND status = 'done' ORDER BY id DESC LIMIT 1",
        )
        .get(videoId, prev)?.output ?? ""
    );
  }

  private async writeArticle(video: VideoRow, transcript: string, model: string | null, provider: GenerationProvider | null, ctx: StageContext): Promise<string> {
    // A regeneration keeps the previous article untouched until the new one is complete, writing a draft beside it.
    const replacing = this.article(video.id) !== null;
    const column = replacing ? "draft" : "markdown";
    this.db
      .query(
        replacing
          ? "UPDATE articles SET draft = '' WHERE video_id = ?"
          : "INSERT INTO articles (video_id, markdown, complete) VALUES (?, '', 0) ON CONFLICT(video_id) DO UPDATE SET markdown = '', complete = 0",
      )
      .run(video.id);
    let offset = 0;
    const articleCtx: ArticleContext = {
      ...ctx,
      onText: (delta) => {
        if (ctx.signal.aborted) return;
        this.db.query(`UPDATE articles SET ${column} = ${column} || ? WHERE video_id = ?`).run(delta, video.id);
        for (const l of this.chunkListeners) l({ id: video.id, offset, delta });
        offset += delta.length;
      },
    };
    try {
      const { markdown, usage } = await this.deps.writer.write(
        {
          transcript,
          video: {
            youtubeId: video.youtube_id,
            url: video.url,
            title: video.title,
            channelName: video.channel_name,
            durationSeconds: video.duration_seconds,
          },
          instructions: assembleInstructions(this.settings.get("globalPrompt")!, this.settings.get("articleLanguage")!, this.channelInstructions(video.channel_id)),
          model: model!,
          provider: provider!,
        },
        articleCtx,
      );
      // Whatever the writer consumed is recorded, even when the video was cancelled meanwhile.
      const usageRecordId = this.recordUsage(video.id, usage);
      // A writer that returns after being aborted must not turn a truncated text into the Article.
      ctx.signal.throwIfAborted();
      this.db.query("UPDATE articles SET markdown = ?, complete = 1, draft = NULL, usage_record_id = ? WHERE video_id = ?").run(markdown, usageRecordId, video.id);
      return markdown;
    } catch (err) {
      if (err instanceof ArticleWriteError) this.recordUsage(video.id, err.usage);
      if (replacing) this.db.query("UPDATE articles SET draft = NULL WHERE video_id = ?").run(video.id);
      throw err;
    }
  }

  private recordUsage(videoId: number, usage: ArticleUsage) {
    return Number(this.db
      .query("INSERT INTO usage_records (video_id, model, input_tokens, output_tokens, credits, created_at, provider, cached_input_tokens, cost_usd, cost_kind, cost_source, credits_known, tokens_known) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(videoId, usage.model, usage.inputTokens, usage.outputTokens, usage.credits ?? 0, this.clock.now(), usage.provider ?? "copilot", usage.cachedInputTokens ?? 0, usage.costUsd ?? null, usage.costKind ?? null, usage.costSource ?? null, usage.credits === null ? 0 : 1, usage.tokensKnown === false ? 0 : 1).lastInsertRowid);
  }

  /** Read at write time, so a regeneration picks up edits. An ad hoc or removed Channel has none. */
  private channelInstructions(channelId: number | null): string | null {
    if (channelId === null) return null;
    return this.db.query<{ instructions: string | null }, [number]>("SELECT instructions FROM channels WHERE id = ?").get(channelId)?.instructions ?? null;
  }

  private async runStage(stage: Stage, videoId: number, model: string | null, provider: GenerationProvider | null, ctx: StageContext): Promise<string> {
    const video = this.db.query<VideoRow, [number]>("SELECT * FROM videos WHERE id = ?").get(videoId)!;
    switch (stage) {
      case "download": {
        return (await this.deps.downloader.download(video.youtube_id, ctx)).audioPath;
      }
      case "transcription": {
        const { language, segments } = await this.deps.transcriber.transcribe(this.previousOutput(videoId, stage), ctx);
        ctx.signal.throwIfAborted();
        this.db
          .query("INSERT INTO transcripts (video_id, language, segments) VALUES (?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET language = excluded.language, segments = excluded.segments")
          .run(videoId, language, JSON.stringify(segments));
        return formatTranscript(segments);
      }
      case "article":
        return this.writeArticle(video, this.previousOutput(videoId, stage), model, provider, ctx);
      case "delivery": {
        const to = this.settings.get("recipient");
        if (!to) throw new Error("Recipient not configured: set the destination email in Settings");
        await this.deps.mailer.send({ to, ...this.email(videoId)! }, ctx);
        return "";
      }
    }
  }
}
