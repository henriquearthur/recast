import { getLocale, t } from "../lib/i18n";
import { ArrowUpRight } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { VideoView } from "../../server/pipeline";
import type { Stats } from "../../server/stats";
import { Empty, Eyebrow, PageHeader, Panel, PanelHeader, Sparkline, StatTile, Tape } from "../components/recast";
import { Skeleton } from "../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip";
import { STAGE_COLOR, STAGE_LABEL } from "../labels";
import { compact, dayKey, elapsed, humanDuration, number, readMinutes, shortDate, ticks } from "../lib/format";

const DAY = 86_400_000;
/** Reading time of a number of words, in seconds, at the pace every Article is measured with. */
const readSecondsOf = (words: number) => Math.round(words / 200) * 60;
/** Noon of a `YYYY-MM-DD` day, in the browser's time zone. */
const dayAt = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y!, m! - 1, d!, 12).getTime();
};

function ChartTip({ active, payload, label }: { active?: boolean; payload?: { payload: { day: string; watch: number; read: number; videos: number } }[]; label?: string }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-semibold">{label}</p>
      <p className="flex items-center gap-2">
        <span className="h-0.5 w-3 rounded bg-(--chart-watch)" /> {t("Video")} <span className="ml-auto pl-4 font-mono tabular-nums">{humanDuration(d.watch * 60)}</span>
      </p>
      <p className="flex items-center gap-2">
        <span className="h-0.5 w-3 rounded bg-(--chart-read)" /> {t("Reading")} <span className="ml-auto pl-4 font-mono tabular-nums">{humanDuration(d.read * 60)}</span>
      </p>
      <p className="mt-1 text-muted-foreground">{d.videos === 1 ? t("1 video") : t("{0} videos", d.videos)}</p>
    </div>
  );
}

/** Last 30 days: what arrived as video (grey) and what it became as reading (green), on the same scale. */
function DailyChart({ stats }: { stats: Stats }) {
  const byDay = new Map(stats.daily.map((d) => [d.day, d]));
  const today = new Date().setHours(12, 0, 0, 0);
  const data = Array.from({ length: 30 }, (_, i) => {
    const at = today - (29 - i) * DAY;
    const d = byDay.get(dayKey(at));
    return { day: dayKey(at), label: shortDate(at), watch: Math.round((d?.watchSeconds ?? 0) / 60), read: Math.round((d?.readWords ?? 0) / 200), videos: d?.articles ?? 0 };
  });
  const total = data.reduce((sum, d) => sum + d.videos, 0);
  const axis = ticks(Math.max(...data.map((d) => d.watch), 10), [5, 10, 15, 30, 60, 120, 240, 480, 960]);
  return (
    <Panel className="rise flex flex-col">
      <PanelHeader title={t("Video in, reading out")} hint={t("Minutes per day, over the last 30 days · {0}", total === 1 ? t("1 article") : t("{0} articles", total))}>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-(--chart-watch)" /> {t("Video")} </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-(--chart-read)" /> {t("Reading")} </span>
        </div>
      </PanelHeader>
      <div className="h-64 shrink-0 px-3 pt-4 pb-3">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="18%" barGap={2}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--axis)" }} interval={6} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickMargin={8} />
            <YAxis width={44} ticks={axis} domain={[0, axis.at(-1)!]} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickFormatter={(v: number) => (v >= 60 ? `${number(v / 60, v % 60 ? 1 : 0)} h` : `${v} min`)} />
            <ChartTooltip content={<ChartTip />} cursor={{ fill: "var(--cursor)" }} />
            <Bar dataKey="watch" fill="var(--chart-watch)" radius={[3, 3, 0, 0]} maxBarSize={9} isAnimationActive={false} />
            <Bar dataKey="read" fill="var(--chart-read)" radius={[3, 3, 0, 0]} maxBarSize={9} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Panel>
  );
}

/** Where the processing time of an average Video goes: one bar split by Stage. */
function StageTime({ stats }: { stats: Stats }) {
  const stages = stats.stages.filter((s) => s.avgMs);
  const total = stages.reduce((sum, s) => sum + s.avgMs!, 0);
  return (
    <Panel className="rise">
      <PanelHeader title={t("From video to email")} hint={total ? t("An average of {0} processing per video.", elapsed(total)) : t("No completed videos to measure yet.")} />
      {total > 0 && (
        <div className="p-6 pt-5">
          <div className="flex h-6 gap-0.5">
            {stages.map((s) => (
              <Tooltip key={s.stage}>
                <TooltipTrigger asChild>
                  <div className="h-full min-w-1 first:rounded-l-md last:rounded-r-md" style={{ width: `${(s.avgMs! / total) * 100}%`, background: STAGE_COLOR[s.stage] }} />
                </TooltipTrigger>
                <TooltipContent>
                  {t(STAGE_LABEL[s.stage]!)}: {elapsed(s.avgMs!)} ({Math.round((s.avgMs! / total) * 100)}%)
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
          <table className="mt-5 w-full text-sm">
            <thead className="sr-only">
              <tr>
                <th>{t("Stage")}</th>
                <th>{t("Average duration")}</th>
                <th>{t("Share of total")}</th>
                <th>{t("Failures")}</th>
              </tr>
            </thead>
            <tbody>
              {stats.stages.map((s) => (
                <tr key={s.stage} className="border-t first:border-0">
                  <td className="py-2.5">
                    <span className="flex items-center gap-2 font-medium">
                      <span className="size-2.5 rounded-sm" style={{ background: STAGE_COLOR[s.stage] }} />
                      {t(STAGE_LABEL[s.stage]!)}
                    </span>
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{s.avgMs ? elapsed(s.avgMs) : "—"}</td>
                  <td className="w-14 py-2.5 text-right text-muted-foreground tabular-nums">{s.avgMs ? `${Math.round((s.avgMs / total) * 100)}%` : ""}</td>
                  <td className="hidden w-28 py-2.5 text-right text-xs text-muted-foreground sm:table-cell">
                    {s.failed ? t("{0} {1} out of {2}", s.failed, s.failed === 1 ? t("failure") : t("failures"), s.done + s.failed) : t("no failures")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}


/** The whole point of Recast in one sentence: how much video became how much reading. */
function Hero({ stats }: { stats: Stats }) {
  const readSeconds = readSecondsOf(stats.readWords);
  return (
    <Panel className="rise grid overflow-hidden lg:grid-cols-[1.55fr_1fr]">
      <div className="p-6 sm:p-9">
        <Eyebrow>{t("So far")}</Eyebrow>
        <h2 className="mt-3 font-display text-[2.25rem] leading-[1.06] font-bold tracking-tight text-balance sm:text-[3.25rem]">
          {humanDuration(stats.watchSeconds)} {t("of video became")} <span className="mark whitespace-nowrap">{humanDuration(readSeconds)}</span> {t("of reading.")}
        </h2>
        <Tape watchSeconds={stats.watchSeconds} readMinutes={readSeconds / 60} large className="mt-8" />
      </div>
      <dl className="grid content-center gap-6 border-t bg-surface-subtle p-6 sm:grid-cols-3 sm:p-9 lg:grid-cols-1 lg:border-t-0 lg:border-l">
        {[
          [number(stats.articles), stats.articles === 1 ? t("article written") : t("articles written")],
          [`${number(stats.watchSeconds / Math.max(readSeconds, 60), 1)}×`, t("faster than watching")],
          [humanDuration(Math.max(0, stats.watchSeconds - readSeconds)), t("given back to your day")],
        ].map(([value, label]) => (
          <div key={label}>
            <dt className="sr-only">{label}</dt>
            <dd className="font-display text-[2rem] leading-none font-semibold tracking-tight">{value}</dd>
            <dd className="mt-1.5 text-sm text-muted-foreground">{label}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function Tiles({ stats }: { stats: Stats }) {
  const today = new Date().setHours(12, 0, 0, 0);
  const byDay = new Map(stats.daily.map((d) => [d.day, d.articles]));
  const span = (from: number) => Array.from({ length: 30 }, (_, i) => byDay.get(dayKey(today - (from - i) * DAY)) ?? 0);
  const recent = span(29);
  const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
  return (
    <div className="rise grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      <StatTile label={t("Articles in 30 days")} value={number(sum(recent))} note={t("{0} in the previous 30 days", number(sum(span(59))))}>
        <Sparkline values={recent} />
      </StatTile>
      <StatTile label={t("Average article")} value={number(Math.max(1, Math.round(stats.readWords / stats.articles / 200)))} unit={t("min of reading")} note={t("for {0} of video, on average", humanDuration(Math.round(stats.watchSeconds / stats.articles)))} />
      <StatTile label={t("Videos that became articles")} value={`${number((stats.articles / stats.videos) * 100)}%`} note={t("{0} of {1} videos", number(stats.articles), number(stats.videos))} />
      <StatTile label={t("Words written")} value={compact(stats.readWords)} note={t("about {0} book pages", number(Math.max(1, Math.round(stats.readWords / 300))))} />
    </div>
  );
}

/** Each origin as two bars on one scale: the video it brought (grey) and the reading it became (green). */
function ByChannel({ stats }: { stats: Stats }) {
  const rows = stats.channels.filter((c) => c.articles > 0);
  const max = Math.max(...rows.map((c) => c.watchSeconds), 1);
  return (
    <Panel className="rise">
      <PanelHeader title={t("By channel")} hint={t("Video received and reading delivered, by source.")}>
        <div className="flex gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-(--chart-watch)" /> {t("Video")} </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-(--chart-read)" /> {t("Reading")} </span>
        </div>
      </PanelHeader>
      <ul className="space-y-5 p-6 pt-5">
        {rows.map((c) => {
          const read = Math.max(60, readSecondsOf(c.readWords));
          return (
            <li key={c.channelId ?? "adhoc"}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="truncate font-medium">{c.channelId === null ? t("Ad hoc videos") : (c.name ?? t("Channel {0}", c.channelId))}</span>
                <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums">
                  {humanDuration(c.watchSeconds)} → {humanDuration(read)}
                </span>
              </div>
              <div className="mt-1.5 space-y-0.5">
                <div className="h-2 min-w-1 rounded-r bg-(--chart-watch)" style={{ width: `${(c.watchSeconds / max) * 100}%` }} />
                <div className="h-2 min-w-1 rounded-r bg-(--chart-read)" style={{ width: `${(read / max) * 100}%` }} />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {c.articles === 1 ? t("1 article") : t("{0} articles", number(c.articles))} · {number(c.watchSeconds / read, 1)}× {t("faster than watching")}
              </p>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Which days of the week the Videos arrive on. */
function Weekdays({ stats }: { stats: Stats }) {
  const counts = Array.from({ length: 7 }, () => 0);
  for (const d of stats.daily) counts[(new Date(dayAt(d.day)).getDay() + 6) % 7]! += d.articles;
  const max = Math.max(...counts, 1);
  // 2024-01-01 was a Monday.
  const name = (i: number, weekday: "short" | "long") => new Date(2024, 0, 1 + i).toLocaleDateString(getLocale(), { weekday }).replace(".", "");
  return (
    <Panel className="rise">
      <PanelHeader title={t("Weekly rhythm")} hint={t("Articles by the weekday the video arrived.")} />
      <ol className="flex h-52 items-stretch gap-2 p-6 pt-5">
        {counts.map((count, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <li className="flex flex-1 flex-col items-center gap-1.5">
                <span className="font-mono text-xs tabular-nums">{count}</span>
                <span className="flex w-full flex-1 items-end border-b border-(--axis)">
                  <span className="mx-auto w-full max-w-9 rounded-t bg-(--chart-read)" style={{ height: `${(count / max) * 100}%` }} />
                </span>
                <span className="text-xs text-muted-foreground capitalize">{name(i, "short")}</span>
              </li>
            </TooltipTrigger>
            <TooltipContent>
              <span className="capitalize">{name(i, "long")}</span>: {count === 1 ? t("1 article") : t("{0} articles", count)}
            </TooltipContent>
          </Tooltip>
        ))}
      </ol>
    </Panel>
  );
}

/** The extremes among what was written so far. */
function Records({ stats, videos }: { stats: Stats; videos: VideoView[] }) {
  const done = videos.flatMap((v) => {
    const read = readMinutes(v);
    return read !== null && v.durationSeconds ? [{ v, read, ratio: v.durationSeconds / (read * 60) }] : [];
  });
  const top = <T,>(list: T[], by: (x: T) => number) => list.reduce<T | null>((best, x) => (best === null || by(x) > by(best) ? x : best), null);
  const longest = top(done, (d) => d.v.durationSeconds!);
  // The longest Video tends to be the most compressed one too: a record is not told twice.
  const densest = top(done.filter((d) => d !== longest), (d) => d.ratio);
  const busiest = top(stats.daily, (d) => d.articles);
  const records: { label: string; value: string; title: string; note: string; href?: string }[] = [];
  if (longest) records.push({ label: t("Longest video"), value: humanDuration(longest.v.durationSeconds!), title: longest.v.title ?? longest.v.url, note: t("read in {0} min", longest.read), href: `#/videos/${longest.v.id}` });
  if (densest) records.push({ label: t("Highest compression"), value: `${number(densest.ratio, 1)}×`, title: densest.v.title ?? densest.v.url, note: t("{0} of video in {1} min of reading", humanDuration(densest.v.durationSeconds!), densest.read), href: `#/videos/${densest.v.id}` });
  if (busiest?.articles) records.push({ label: t("Busiest day"), value: busiest.articles === 1 ? t("1 article") : t("{0} articles", busiest.articles), title: shortDate(dayAt(busiest.day)), note: t("{0} of video in a single day", humanDuration(busiest.watchSeconds)) });
  if (!records.length) return null;
  return (
    <Panel className="rise overflow-hidden">
      <PanelHeader title={t("Records")} hint={t("The extremes among finished articles.")} />
      <ul className="mt-5 divide-y border-t">
        {records.map((r) => {
          const body = (
            <>
              <Eyebrow>{r.label}</Eyebrow>
              <p className="mt-2 font-display text-2xl leading-none font-semibold tracking-tight">{r.value}</p>
              <p className="mt-3 line-clamp-2 leading-snug font-semibold text-pretty group-hover:underline">
                {r.title}
                {r.href && <ArrowUpRight className="ml-1 inline size-3.5 text-muted-foreground" />}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{r.note}</p>
            </>
          );
          return (
            <li key={r.label}>
              {r.href ? <a href={r.href} className="group block h-full p-6 transition-colors hover:bg-surface-subtle">{body}</a> : <div className="p-6">{body}</div>}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

export function StatsPage({ stats, videos }: { stats: Stats | null; videos: VideoView[] | null }) {
  return (
    <>
      <PageHeader title={t("Stats")} description={t("What Recast has turned into reading so far, and how long it took.")} />
      {!stats ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : stats.articles === 0 ? (
        <Empty title={t("No numbers yet")}>{t("Stats appear here once the first article is ready.")}</Empty>
      ) : (
        <div className="space-y-5">
          <Hero stats={stats} />
          <Tiles stats={stats} />
          <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
            <DailyChart stats={stats} />
            <StageTime stats={stats} />
          </div>
          <div className="grid gap-5 lg:grid-cols-[1.55fr_1fr]">
            <ByChannel stats={stats} />
            <div className="space-y-5">
              <Weekdays stats={stats} />
              <Records stats={stats} videos={videos ?? []} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
