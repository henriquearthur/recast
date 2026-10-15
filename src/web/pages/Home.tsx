import { t, translateMessage } from "../lib/i18n";
import { AlertTriangle, ArrowRight, ArrowUpRight, Radar } from "lucide-react";
import { useState } from "react";
import { parseArticle } from "../../article";
import type { ChannelView } from "../../server/channels";
import type { VideoView } from "../../server/pipeline";
import type { Stats } from "../../server/stats";
import { ChannelAvatar, Empty, Eyebrow, Panel, PanelHeader, Tape, VideoThumb } from "../components/recast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { STAGE_COLOR, STAGE_LABEL, STAGE_ORDER } from "../labels";
import { clock, dayKey, humanDuration, number, readMinutes, relative } from "../lib/format";
import { api, useNow } from "../lib/live";
import { cn } from "../lib/utils";

const DAY = 86_400_000;

export function NewVideo({ className }: { className?: string }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const video = await api.send<VideoView>("POST", "/api/videos", { url });
      setUrl("");
      location.hash = `#/videos/${video.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }
  return (
    <form onSubmit={submit} className={className}>
      <label htmlFor="new-video" className="font-display text-lg font-semibold tracking-tight"> {t("Turn a video into an article")} </label>
      <p className="mt-1 text-sm text-muted-foreground">{t("Paste a YouTube video URL. The article will arrive by email.")}</p>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
        <Input
          id="new-video"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          aria-invalid={!!error}
          className="h-11 min-w-0 flex-1 bg-card font-mono text-[0.8125rem]"
        />
        <Button size="lg" disabled={busy || !url.trim()} className="h-11 rounded-lg">
          {busy ? t("Looking up…") : t("Create article")} <ArrowRight />
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          {translateMessage(error)}
        </p>
      )}
    </form>
  );
}

function Station({ title, color, count, active, children }: { title: string; color?: string; count?: number; active: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0 flex-1 overflow-hidden px-6 pb-5 lg:px-5 lg:first:pl-6 lg:last:pr-6">
      <div className="relative -mx-6 mb-4 h-px bg-border">{active && <div className="flowing absolute inset-0 opacity-70" />}</div>
      <div className="mb-3 flex items-center gap-2">
        <span className={cn("size-2.5 rounded-full", active && "ring-4 ring-marker")} style={{ background: color ?? "var(--foreground)" }} />
        <h3 className="text-sm font-semibold">{title}</h3>
        {!!count && <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-semibold tabular-nums">{count}</span>}
      </div>
      <div className="space-y-3 text-sm">{children}</div>
    </div>
  );
}

function StageStation({ stage, videos }: { stage: string; videos: VideoView[] }) {
  const at = (v: VideoView) => v.stages.find((s) => s.stage === stage)!;
  const running = videos.filter((v) => at(v).status === "running");
  const waiting = videos.filter((v) => v.state === "in_progress" && at(v).queuePosition != null).sort((a, b) => at(a).queuePosition! - at(b).queuePosition!);
  const failed = videos.filter((v) => v.state === "failed" && at(v).status === "failed");
  const title = (v: VideoView) => v.title ?? v.url;
  return (
    <Station title={t(STAGE_LABEL[stage]!)!} color={STAGE_COLOR[stage]} count={running.length + waiting.length} active={running.length > 0}>
      {running.map((v) => (
        <a key={v.id} href={`#/videos/${v.id}`} className="group block">
          <p className="truncate font-medium group-hover:underline">{title(v)}</p>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-foreground transition-[width] duration-700" style={{ width: `${Math.max(3, at(v).percent ?? 0)}%` }} />
          </div>
          <p className="mt-1 truncate font-mono text-[0.6875rem] text-muted-foreground">
            {Math.round(at(v).percent ?? 0)}%{at(v).detail ? ` · ${translateMessage(at(v).detail!)}` : ""}
          </p>
        </a>
      ))}
      {waiting.length > 0 && (
        <ol className="space-y-1">
          {waiting.slice(0, 3).map((v) => (
            <li key={v.id} className="flex gap-2 text-muted-foreground">
              <span className="w-4 shrink-0 font-mono text-xs leading-5 tabular-nums">{at(v).queuePosition}</span>
              <a href={`#/videos/${v.id}`} className="truncate hover:text-foreground hover:underline">
                {title(v)}
              </a>
            </li>
          ))}
          {waiting.length > 3 && <li className="pl-6 text-xs text-muted-foreground">{t("and another")} {waiting.length - 3} {t("in the queue")}</li>}
        </ol>
      )}
      {failed.slice(0, 2).map((v) => (
        <a key={v.id} href={`#/videos/${v.id}`} className="block truncate text-destructive hover:underline" title={at(v).error ? translateMessage(at(v).error!) : undefined}> {t("Failed:")} {title(v)}
        </a>
      ))}
      {!running.length && !waiting.length && !failed.length && <p className="text-muted-foreground">{t("Idle")}</p>}
    </Station>
  );
}

/** Detection followed by the four Stages, with what runs, waits and failed in each. */
function Pipeline({ videos, channels }: { videos: VideoView[]; channels: ChannelView[] }) {
  const now = useNow();
  const active = channels.filter((c) => c.status === "active");
  const next = Math.min(...active.map((c) => c.nextCheckAt ?? Infinity));
  const busy = videos.filter((v) => v.state === "in_progress").length;
  return (
    <Panel className="rise overflow-hidden">
      <PanelHeader title={t("Now")} hint={busy ? t("{0} {1} through the stages.", busy, busy === 1 ? t("video moving") : t("videos moving")) : t("Nothing is processing. New videos from followed channels are added automatically.")} />
      <div className="mt-5 flex flex-col lg:flex-row lg:divide-x">
        <Station title={t("Detection")} active={false}>
          <p className="flex items-center gap-1.5">
            <Radar className="size-4 text-muted-foreground" />
            {active.length === 1 ? t("1 active channel") : t("{0} active channels", active.length)}
          </p>
          <p className="text-muted-foreground">
            {Number.isFinite(next) ? (next <= now ? t("Checking now") : t("Next check {0}", relative(next, now))) : <a href="#/channels" className="text-pine hover:underline">{t("Follow a channel")}</a>}
          </p>
        </Station>
        {STAGE_ORDER.map((stage) => (
          <StageStation key={stage} stage={stage} videos={videos} />
        ))}
      </div>
    </Panel>
  );
}

export function ArticleRow({ video }: { video: VideoView }) {
  const read = readMinutes(video);
  return (
    <a href={`#/videos/${video.id}`} className="group flex items-center gap-4 px-6 py-3.5 transition-colors hover:bg-surface-subtle">
      <VideoThumb video={video} className="w-24 sm:w-32" badge={false} />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 leading-snug font-semibold text-pretty group-hover:underline">{video.title ?? video.url}</p>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {video.channelName} · {relative(video.createdAt)}
        </p>
      </div>
      {read !== null && video.durationSeconds != null && (
        <div className="hidden w-40 shrink-0 sm:block">
          <p className="mb-1.5 flex justify-between font-mono text-xs tabular-nums">
            <span className="font-semibold">{read} min</span>
            <span className="text-muted-foreground">{clock(video.durationSeconds)}</span>
          </p>
          <Tape watchSeconds={video.durationSeconds} readMinutes={read} />
        </div>
      )}
      <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-foreground" />
    </a>
  );
}

/** The newest Article, opened up: its summary is right there, so the Home is already something to read. */
function Featured({ video }: { video: VideoView }) {
  const read = readMinutes(video)!;
  const points = parseArticle(video.article!.markdown)
    .summary.split("\n")
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").replace(/[*_`]/g, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  return (
    <Panel className="rise overflow-hidden">
      <a href={`#/videos/${video.id}`} className="group flex h-full flex-col p-6 sm:p-9">
        <div className="flex items-start gap-5">
          <div className="min-w-0 flex-1">
            <Eyebrow>
              {t("Latest article")} · {relative(video.createdAt)}
            </Eyebrow>
            <h1 className="mt-3 font-display text-[1.75rem] leading-[1.1] font-bold tracking-tight text-balance group-hover:underline sm:text-[2.25rem]">{video.title ?? video.url}</h1>
            <p className="mt-2 text-sm text-muted-foreground">{video.channelName}</p>
          </div>
          <VideoThumb video={video} className="hidden w-44 sm:block" />
        </div>
        {points.length > 0 && (
          <ul className="mt-6 space-y-2 border-l-[3px] border-marker pl-4 font-serif text-[1.0625rem] leading-snug">
            {points.map((point) => (
              <li key={point} className="line-clamp-2">
                {point}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex flex-wrap items-end gap-x-6 gap-y-4 pt-7">
          {video.durationSeconds != null && (
            <div className="min-w-48 flex-1">
              <p className="mb-1.5 flex justify-between text-xs text-muted-foreground">
                <span>
                  <strong className="font-semibold text-foreground">{read} min</strong> {t("of reading")}
                </span>
                <span>{t("{0} of video", humanDuration(video.durationSeconds))}</span>
              </p>
              <Tape watchSeconds={video.durationSeconds} readMinutes={read} />
            </div>
          )}
          <span className="inline-flex h-10 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-primary-foreground">
            {t("Read article")} <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </a>
    </Panel>
  );
}

function Welcome() {
  return (
    <Panel className="rise p-6 sm:p-9">
      <Eyebrow>Recast</Eyebrow>
      <h1 className="mt-3 font-display text-4xl leading-[1.05] font-bold tracking-tight text-balance sm:text-5xl">
        {t("Long videos,")} <span className="mark">{t("read in minutes")}</span>.
      </h1>
      <p className="mt-4 max-w-md text-muted-foreground">{t("Follow channels or paste a video: Recast downloads the audio, transcribes it, writes an article in your language, and sends it by email.")}</p>
      <ol className="mt-7 space-y-2.5 text-sm">
        {[
          ["download", t("Downloads audio only")],
          ["transcription", t("Transcribes the original language")],
          ["article", t("Writes the article in your language")],
          ["delivery", t("Sends it to your email")],
        ].map(([stage, text]) => (
          <li key={stage} className="flex items-center gap-2.5">
            <span className="size-2.5 rounded-sm" style={{ background: STAGE_COLOR[stage!] }} />
            <span className="w-24 font-semibold">{t(STAGE_LABEL[stage!]!)}</span>
            <span className="text-muted-foreground">{text}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** The last seven days in one line, as the door to the Stats page. */
function Week({ stats }: { stats: Stats }) {
  const since = dayKey(Date.now() - 6 * DAY);
  const week = stats.daily.filter((d) => d.day >= since).reduce((sum, d) => ({ articles: sum.articles + d.articles, watch: sum.watch + d.watchSeconds, words: sum.words + d.readWords }), { articles: 0, watch: 0, words: 0 });
  return (
    <a href="#/stats" className="group block">
      <Eyebrow>{t("Last 7 days")}</Eyebrow>
      <p className="mt-2 text-sm text-pretty">
        {week.articles === 0 ? (
          <span className="text-muted-foreground">{t("No new articles this week.")}</span>
        ) : (
          <>
            <strong className="font-semibold">{week.articles === 1 ? t("1 article") : t("{0} articles", number(week.articles))}</strong>: {humanDuration(week.watch)} {t("of video became")} <span className="mark font-semibold whitespace-nowrap">{humanDuration(Math.max(1, Math.round(week.words / 200)) * 60)}</span> {t("of reading.")}
          </>
        )}
      </p>
      <p className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-pine group-hover:underline">
        {t("View stats")} <ArrowRight className="size-3.5" />
      </p>
    </a>
  );
}

/** The followed Channels at a glance: who is being watched and what each last brought in. */
function Following({ channels, videos, stats }: { channels: ChannelView[]; videos: VideoView[]; stats: Stats | null }) {
  const now = useNow();
  const latest = (c: ChannelView) => videos.find((v) => v.channelId === c.id && v.article?.complete);
  const rows = channels.map((c) => ({ c, last: latest(c), articles: stats?.channels.find((s) => s.channelId === c.id)?.articles ?? 0 })).sort((a, b) => (b.last?.createdAt ?? 0) - (a.last?.createdAt ?? 0));
  const active = channels.filter((c) => c.status === "active").length;
  return (
    <Panel className="rise flex flex-col overflow-hidden">
      <PanelHeader title={t("Followed channels")} hint={channels.length ? t("{0} of {1} being checked.", active, channels.length) : t("Every new video from a followed channel becomes an article automatically.")}>
        {channels.length > 0 && (
          <Button asChild variant="ghost" size="sm">
            <a href="#/channels">
              {t("Manage")} <ArrowRight />
            </a>
          </Button>
        )}
      </PanelHeader>
      {channels.length === 0 ? (
        <div className="m-6 rounded-2xl border border-dashed px-6 py-8 text-center">
          <p className="font-display text-lg font-semibold">{t("No channels followed")}</p>
          <Button asChild variant="outline" size="sm" className="mt-3">
            <a href="#/channels">
              {t("Follow a channel")} <ArrowRight />
            </a>
          </Button>
        </div>
      ) : (
        <ul className="mt-3 divide-y pb-2">
          {rows.slice(0, 6).map(({ c, last, articles }) => (
            <li key={c.id} className="flex items-center gap-3 px-6 py-3">
              <ChannelAvatar name={c.name} imageUrl={c.imageUrl} className={cn("size-9 text-xs", c.status === "paused" && "opacity-50")} />
              <div className="min-w-0 flex-1">
                <p className="truncate leading-snug font-semibold">{c.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {last ? (
                    <a href={`#/videos/${last.id}`} className="hover:text-foreground hover:underline">
                      {last.title ?? last.url}
                    </a>
                  ) : (
                    t("No articles yet")
                  )}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <p className="flex items-center justify-end gap-1.5 font-medium text-foreground">
                  {c.lastError ? <AlertTriangle className="size-3.5 text-critical" aria-label={t("Last check failed")} /> : <span className={cn("size-1.5 rounded-full", c.status === "paused" ? "bg-muted-foreground" : "bg-good")} />}
                  {c.status === "paused" ? t("Paused") : articles === 1 ? t("1 article") : t("{0} articles", number(articles))}
                </p>
                {last && <p className="mt-0.5">{relative(last.createdAt, now)}</p>}
              </div>
            </li>
          ))}
          {rows.length > 6 && (
            <li className="px-6 py-3 text-sm text-muted-foreground">
              <a href="#/channels" className="hover:text-foreground hover:underline">
                {t("and {0} more", rows.length - 6)}
              </a>
            </li>
          )}
        </ul>
      )}
    </Panel>
  );
}

export function HomePage({ videos, channels, stats }: { videos: VideoView[] | null; channels: ChannelView[] | null; stats: Stats | null }) {
  if (!videos || !channels)
    return (
      <div className="space-y-5">
        <Skeleton className="h-80 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  const [featured, ...rest] = videos.filter((v) => v.article?.complete).slice(0, 7);
  // What is being processed comes first only while there is something to follow.
  const live = videos.some((v) => v.state === "in_progress");
  const pipeline = <Pipeline videos={videos} channels={channels} />;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
        {featured ? <Featured video={featured} /> : <Welcome />}
        <Panel className="rise flex flex-col justify-between gap-8 bg-surface-subtle p-6 sm:p-9">
          <NewVideo />
          {stats && stats.articles > 0 && <Week stats={stats} />}
        </Panel>
      </div>
      {live && pipeline}
      <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
        <Panel className="rise overflow-hidden">
          <PanelHeader title={t("To read")} hint={t("The latest articles.")}>
            {featured && (
              <Button asChild variant="ghost" size="sm">
                <a href="#/articles"> {t("View all")} <ArrowRight />
                </a>
              </Button>
            )}
          </PanelHeader>
          {rest.length ? (
            <div className="mt-3 divide-y pb-2">{rest.map((v) => <ArticleRow key={v.id} video={v} />)}</div>
          ) : (
            <Empty title={featured ? t("That's all for now") : t("No articles yet")} className="m-6">
              {featured ? t("New articles appear here as videos are processed.") : t("The first article appears here as soon as a video finishes processing.")}
            </Empty>
          )}
        </Panel>
        <Following channels={channels} videos={videos} stats={stats} />
      </div>
      {!live && pipeline}
    </div>
  );
}
