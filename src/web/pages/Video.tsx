import { usd } from "../lib/format";
import { providerName } from "../../server/generation";
import { t, translateMessage } from "../lib/i18n";
import { AlertTriangle, ArrowLeft, Ban, Check, ChevronRight, Loader2, Play, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { parseArticle, readingMinutes } from "../../article";
import { markdownToHtml } from "../../markdown";
import type { TranscriptSegment } from "../../server/deps";
import type { VideoView } from "../../server/pipeline";
import { Empty, Eyebrow, Panel, StateBadge, Tape, VideoThumb } from "../components/recast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { STAGE_COLOR, STAGE_LABEL, STATUS_LABEL } from "../labels";
import { clock, compact, credits, date, elapsed, humanDuration, time } from "../lib/format";
import { api, onEvent } from "../lib/live";
import { cn } from "../lib/utils";

type StageView = VideoView["stages"][number];

const STEP_ICON = { waiting: null, running: Loader2, done: Check, failed: AlertTriangle, cancelled: Ban } as const;

function stepNote(s: StageView) {
  if (s.status === "running") return `${Math.round(s.percent ?? 0)}%${s.detail ? ` · ${translateMessage(s.detail)}` : ""}`;
  if (s.status === "waiting") {
    if (s.retryAt) return t("Next attempt at {0}", time(s.retryAt));
    return s.queuePosition ? t("Queue position {0}", s.queuePosition) : t("Waiting for the previous stage");
  }
  if (s.status === "done" && s.startedAt && s.finishedAt) return t("Done in {0}", elapsed(s.finishedAt - s.startedAt));
  return t(STATUS_LABEL[s.status]!);
}

/** The four Stages in order: the path every Video walks, with where this one is. */
function Steps({ video }: { video: VideoView }) {
  return (
    <ol className="grid gap-x-0 gap-y-4 sm:grid-cols-4">
      {video.stages.map((s, i) => {
        const Icon = STEP_ICON[s.status];
        return (
          <li key={s.stage} className="relative flex gap-3 sm:block sm:pr-5">
            {i > 0 && (
              <div className="absolute top-3.5 right-full hidden h-px w-[calc(100%-2.25rem)] -translate-x-1 bg-border sm:block">
                {s.status !== "waiting" || video.stages[i - 1]!.status === "done" ? <div className={cn("absolute inset-0", s.status === "running" || (s.status === "waiting" && video.state === "in_progress") ? "flowing opacity-60" : "bg-foreground")} /> : null}
              </div>
            )}
            <span
              className={cn(
                "grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold",
                s.status === "done" && "border-foreground bg-foreground text-primary-foreground",
                s.status === "running" && "border-foreground bg-marker text-ink",
                s.status === "failed" && "border-critical bg-critical text-white",
                s.status === "cancelled" && "bg-muted text-muted-foreground",
                s.status === "waiting" && "border-dashed bg-card text-muted-foreground",
              )}
            >
              {Icon ? <Icon className={cn("size-3.5", s.status === "running" && "animate-spin")} strokeWidth={2.5} /> : i + 1}
            </span>
            <div className="min-w-0 sm:mt-3">
              <p className="text-sm font-semibold">{t(STAGE_LABEL[s.stage]!)}</p>
              <p className="mt-0.5 text-[0.8125rem] text-muted-foreground">{stepNote(s)}</p>
              {s.status === "running" && (
                <div className="mt-2 h-1.5 max-w-44 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-foreground transition-[width] duration-700" style={{ width: `${Math.max(3, s.percent ?? 0)}%` }} />
                </div>
              )}
              {s.attempts > 1 && <p className="mt-0.5 text-xs text-muted-foreground">{t("Attempt")} {s.attempts} {t("of 3")}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Actions({ video }: { video: VideoView }) {
  const act = (action: string, done: string) => () => api.send("POST", `/api/videos/${video.id}/${action}`).then(() => toast.success(done), (e: Error) => toast.error(translateMessage(e.message)));
  return (
    <div className="flex flex-wrap gap-2">
      <Button asChild>
        <a href={video.url} target="_blank" rel="noreferrer">
          <Play className="fill-current" /> {t("Watch on YouTube")} </a>
      </Button>
      {video.state === "in_progress" && (
        <Button variant="outline" onClick={act("cancel", t("Processing cancelled"))}>
          <X /> {t("Cancel")} </Button>
      )}
      {video.state === "failed" && (
        <Button variant="outline" onClick={act("retry", t("Video returned to the queue"))}>
          <RotateCcw /> {t("Try again")} </Button>
      )}
      {video.state === "cancelled" && (
        <Button variant="outline" onClick={act("resume", t("Video returned to the queue"))}>
          <Play /> {t("Resume")} </Button>
      )}
    </div>
  );
}

function Regenerate({ videoId }: { videoId: number }) {
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api.send("POST", `/api/videos/${videoId}/regenerate`, {});
      toast.success(t("Rewriting the article"));
    } catch (err) {
      toast.error(translateMessage((err as Error).message));
    }
  }
  return (
    <form onSubmit={submit} className="space-y-2">
      <Eyebrow>{t("Rewrite")}</Eyebrow>
      <Button variant="outline" size="sm" className="w-full">
        <RefreshCw /> {t("Regenerate and resend")} </Button>
      <p className="text-xs text-muted-foreground">{t("Uses the provider and model from Settings.")}</p>
    </form>
  );
}

function Article({ video }: { video: VideoView }) {
  const article = video.article!;
  const writing = !article.complete || article.draft !== null;
  const text = article.draft ?? article.markdown;
  const parts = useMemo(() => parseArticle(text), [text]);
  const body = useRef<HTMLDivElement>(null);
  const at = (seconds: number) => `https://www.youtube.com/watch?v=${video.youtubeId}&t=${seconds}s`;
  // The renderer only emits fixed Markdown tags over escaped content and http(s) links.
  const html = (markdown: string) => ({ __html: markdownToHtml(markdown, { timecodeHref: at }) });
  const level = parts.body.match(/^#+/m)?.[0].length ?? 2;
  const jump = (index: number) => body.current?.querySelectorAll(`h${level}`)[index]?.scrollIntoView({ block: "start" });
  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <article className="min-w-0 max-w-[44rem]">
        {writing && (
          <p className="mb-5 inline-flex items-center gap-2 rounded-full bg-foreground px-3 py-1 text-xs font-semibold text-primary-foreground">
            <Loader2 className="size-3 animate-spin" /> {t("Writing the article…")} </p>
        )}
        {parts.summary && (
          <section className="mb-9 rounded-r-2xl rounded-l-md border-l-4 border-marker bg-marker-soft px-6 py-5">
            <Eyebrow className="mb-3 text-foreground/70">{t("TL;DR · the essentials")}</Eyebrow>
            <div className="prose-article prose-summary" dangerouslySetInnerHTML={html(parts.summary)} />
          </section>
        )}
        <div ref={body} className="prose-article" dangerouslySetInnerHTML={html(parts.body)} />
      </article>
      <aside className="space-y-7 lg:sticky lg:top-24 lg:self-start">
        {parts.sections.length > 1 && (
          <nav aria-label={t("Article sections")}>
            <Eyebrow className="mb-2">{t("In this article")}</Eyebrow>
            <ul className="border-l">
              {parts.sections.map((s, i) => (
                <li key={i}>
                  <button onClick={() => jump(i)} className="-ml-px flex w-full items-baseline justify-between gap-3 border-l border-transparent py-1.5 pl-3 text-left text-sm text-muted-foreground hover:border-foreground hover:text-foreground">
                    <span>{s.title}</span>
                    {s.timecode && <span className="font-mono text-[0.6875rem] tabular-nums">{s.timecode}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
        )}
        {article.usage && (
          <div>
            <Eyebrow className="mb-2">{t("Generation")}</Eyebrow>
            <dl className="space-y-1.5 text-sm">
              {[
                [t("Provider"), providerName[article.usage.provider ?? "copilot"]],
                [t("Model"), article.usage.model],
                [t("Input"), article.usage.tokensKnown === false ? t("Unavailable") : `${compact(article.usage.inputTokens)} tokens`],
                [t("Output"), article.usage.tokensKnown === false ? t("Unavailable") : `${compact(article.usage.outputTokens)} tokens`],
                [t("Estimated cost"), usd(article.usage.costUsd)],
                [t("Cost type"), article.usage.costKind === "equivalent" ? t("Equivalent") : article.usage.costKind === "estimated" ? t("Estimate") : t("Unavailable")],
                ...(article.usage.credits != null ? [[t("Copilot credits"), credits(article.usage.credits)]] : []),
              ].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-muted-foreground">{k}</dt>
                  <dd className="truncate font-mono text-[0.8125rem] tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            {article.usage.costSource && <p className="mt-2 break-words text-xs text-muted-foreground">{t("Source: {0}", article.usage.costSource)}</p>}
          </div>
        )}
        {video.state === "completed" && <Regenerate videoId={video.id} />}
      </aside>
    </div>
  );
}

/** The full Transcript in its original language, with a time mark per segment that opens the video at that moment. */
function Transcript({ video }: { video: VideoView }) {
  const [data, setData] = useState<{ language: string; segments: TranscriptSegment[] } | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    setData(null);
    void fetch(`/api/videos/${video.id}/transcript`).then((r) => (r.ok ? r.json() : null)).then(setData);
  }, [video.id]);
  if (!data) return <Skeleton className="h-64 rounded-xl" />;
  const q = query.trim().toLowerCase();
  const segments = q ? data.segments.filter((s) => s.text.toLowerCase().includes(q)) : data.segments;
  return (
    <div className="max-w-[52rem]">
      <div className="relative mb-4 max-w-sm">
        <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("Search the transcript")} aria-label={t("Search the transcript")} className="bg-card pl-9" />
      </div>
      {segments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{data.segments.length ? t("No segments match this text.") : t("No speech detected.")}</p>
      ) : (
        <ol className="max-h-[36rem] divide-y overflow-y-auto rounded-xl border bg-card">
          {segments.map((s, i) => (
            <li key={i} className="flex gap-4 px-4 py-2.5 text-[0.9375rem] leading-relaxed">
              <a href={`https://www.youtube.com/watch?v=${video.youtubeId}&t=${Math.floor(s.startMs / 1000)}s`} target="_blank" rel="noreferrer" className="w-14 shrink-0 pt-0.5 font-mono text-xs text-pine tabular-nums hover:underline">
                {clock(s.startMs / 1000)}
              </a>
              <span lang={data.language}>{s.text}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Attempt = { stage: string; attempt: number; status: string; queuedAt: number; startedAt: number | null; finishedAt: number | null; error: string | null; log: string };

/** Attempts of a video, reloaded on every state change and every live log line. */
function useAttempts(video: VideoView) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => onEvent("log", (e: { videoId: number }) => e.videoId === video.id && setTick((n) => n + 1)), [video.id]);
  useEffect(() => {
    let current = true;
    void api.get<Attempt[]>(`/api/videos/${video.id}/attempts`).then((list) => current && setAttempts(list));
    return () => {
      current = false;
    };
  }, [video, tick]);
  return attempts;
}

/** Every attempt of every Stage, oldest first: how long each ran, drawn to the same scale, with its log. */
function History({ video }: { video: VideoView }) {
  const attempts = useAttempts(video);
  const now = Date.now();
  const ms = (a: Attempt) => (a.startedAt === null ? 0 : (a.finishedAt ?? now) - a.startedAt);
  const longest = Math.max(...attempts.map(ms), 1);
  if (!attempts.length) return <Skeleton className="h-40 rounded-xl" />;
  return (
    <ol className="max-w-[52rem] divide-y rounded-xl border bg-card">
      {/* The API appends runs in creation order; existing history entries never move or disappear. */}
      {attempts.map((a, index) => (
        <li key={`${video.id}-${index}`} className="px-4 py-3">
          <details open={a.status === "running"} className="group">
            <summary className="grid cursor-pointer list-none grid-cols-[8.5rem_minmax(0,1fr)_5.5rem] items-center gap-3 text-sm [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2 font-medium">
                <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                <span className="size-2.5 shrink-0 rounded-sm" style={{ background: STAGE_COLOR[a.stage] }} />
                <span className="truncate">{t(STAGE_LABEL[a.stage]!)}</span>
                {a.attempt > 1 && <span className="text-xs font-normal text-muted-foreground">#{a.attempt}</span>}
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2 min-w-1 rounded-r-full" style={{ width: `${(ms(a) / longest) * 100}%`, background: a.status === "failed" ? "var(--critical)" : a.status === "cancelled" ? "var(--cancelled)" : STAGE_COLOR[a.stage], opacity: a.status === "running" ? 0.55 : 1 }} />
                {a.status !== "done" && (
                  <span className={cn("flex shrink-0 items-center gap-1 text-xs font-medium", a.status === "failed" ? "text-destructive" : "text-muted-foreground")}>
                    {a.status === "failed" && <AlertTriangle className="size-3" />}
                    {t(STATUS_LABEL[a.status]!)}
                  </span>
                )}
              </span>
              <span className="text-right text-xs text-muted-foreground tabular-nums">{a.startedAt === null ? "—" : elapsed(ms(a))}</span>
            </summary>
            <div className="mt-2 pl-[1.375rem] text-xs text-muted-foreground">
              <p>
                {a.startedAt ? t("Started at {0} on {1}", time(a.startedAt), date(a.startedAt)) : t("Queued since {0}", time(a.queuedAt))}
                {a.finishedAt ? t(" · finished at {0}", time(a.finishedAt)) : ""}
              </p>
              {a.error && <p className="mt-1 font-medium text-destructive">{translateMessage(a.error)}</p>}
              {a.log && <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-ink p-3 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-[#e4e7de]">{a.log}</pre>}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}

/** Shows the Article as soon as the Article stage is done, independent of what happened to the delivery. */
export function VideoPage({ video, loading }: { video?: VideoView; loading: boolean }) {
  const [tab, setTab] = useState<string | null>(null);
  if (!video)
    return loading ? (
      <Skeleton className="h-96 rounded-2xl" />
    ) : (
      <Empty title={t("Video not found")}> {t("It may have been requested on another installation.")} <a href="#/videos" className="text-pine underline">{t("View all videos")}</a>
      </Empty>
    );
  const read = video.article?.complete ? readingMinutes(parseArticle(video.article.markdown).words) : null;
  const failure = video.stages.find((s) => s.status === "failed" && s.error);
  const transcribed = video.stages.find((s) => s.stage === "transcription")?.status === "done";
  const current = tab ?? (video.article ? "article" : "history");
  const facts = [
    video.publishedAt != null && t("Published on {0}", date(video.publishedAt)),
    video.durationSeconds != null && t("{0} of video", clock(video.durationSeconds)),
    read !== null && t("{0} min of reading", read),
  ].filter(Boolean);
  return (
    <div className="space-y-5">
      <a href="#/videos" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> {t("Videos")} </a>
      <Panel className="rise overflow-hidden">
        <div className="grid gap-6 p-6 sm:p-8 md:grid-cols-[18rem_minmax(0,1fr)]">
          <VideoThumb video={video} className="rounded-xl" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Eyebrow>{video.channelName ?? "YouTube"}</Eyebrow>
              {video.origin === "ad_hoc" && <span className="rounded-full border px-2 py-px text-[0.6875rem] font-medium text-muted-foreground">{t("Ad hoc")}</span>}
              <StateBadge state={video.state} />
            </div>
            <h1 className="mt-2 font-display text-2xl leading-tight font-bold tracking-tight text-balance sm:text-[2rem]">{video.title ?? video.url}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{facts.join(" · ")}</p>
            {read !== null && video.durationSeconds != null && video.durationSeconds > read * 60 && (
              <p className="mt-4 text-[0.9375rem]"> {t("Reading gives back")} <span className="mark font-semibold">{humanDuration(video.durationSeconds - read * 60)}</span> {t("of your day.")} </p>
            )}
            <div className="mt-5">
              <Actions video={video} />
            </div>
          </div>
        </div>
        {read !== null && video.durationSeconds != null && <Tape watchSeconds={video.durationSeconds} readMinutes={read} large className="px-6 pb-6 sm:px-8" />}
        <div className="border-t bg-surface-subtle p-6 sm:px-8">
          <Steps video={video} />
          {failure && (
            <p role="alert" className="mt-5 flex gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger-foreground">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                <strong className="font-semibold">{t(STAGE_LABEL[failure.stage]!)} {t("failed.")}</strong> {translateMessage(failure.error!)}
              </span>
            </p>
          )}
        </div>
      </Panel>
      <Tabs value={current} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="article" disabled={!video.article}>{t("Article")}</TabsTrigger>
          <TabsTrigger value="transcript" disabled={!transcribed}>{t("Transcription")}</TabsTrigger>
          <TabsTrigger value="history">{t("History")}</TabsTrigger>
          <TabsTrigger value="email" disabled={!video.article?.complete}>{t("Email")}</TabsTrigger>
        </TabsList>
        <TabsContent value="article" className="pt-6">{video.article && <Article video={video} />}</TabsContent>
        <TabsContent value="transcript" className="pt-6">{transcribed && <Transcript video={video} />}</TabsContent>
        <TabsContent value="history" className="pt-6"><History video={video} /></TabsContent>
        <TabsContent value="email" className="pt-6">
          <p className="mb-3 text-sm text-muted-foreground">{t("This is how the article arrives in your inbox.")}</p>
          <iframe title={t("Email preview")} sandbox="" src={`/api/videos/${video.id}/email`} className="h-[52rem] w-full max-w-[44rem] rounded-xl border bg-white" />
        </TabsContent>
      </Tabs>
    </div>
  );
}
