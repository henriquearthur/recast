import { t, translateMessage } from "../lib/i18n";
import { useState } from "react";
import type { ChannelView } from "../../server/channels";
import type { VideoView } from "../../server/pipeline";
import { Empty, PageHeader, Panel, StageTrack, StateBadge, Tape, VideoThumb, stageSummary } from "../components/recast";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { VIDEO_STATE_LABEL } from "../labels";
import { clock, readMinutes, relative } from "../lib/format";

function ChannelFilter({ value, onChange, channels }: { value: string; onChange: (v: string) => void; channels: ChannelView[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-48 bg-card" aria-label={t("Filter by channel")}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{t("All channels")}</SelectItem>
        {channels.map((c) => (
          <SelectItem key={c.id} value={String(c.id)}>
            {c.name}
          </SelectItem>
        ))}
        <SelectItem value="adhoc">{t("Ad hoc videos")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

const fromChannel = (channel: string) => (v: VideoView) => channel === "all" || (channel === "adhoc" ? v.origin === "ad_hoc" : v.channelId === Number(channel));
const origin = (v: VideoView) => (v.origin === "ad_hoc" ? t("{0} · ad hoc", v.channelName ?? "YouTube") : (v.channelName ?? ""));

export function ArticlesPage({ videos, channels }: { videos: VideoView[] | null; channels: ChannelView[] }) {
  const [channel, setChannel] = useState("all");
  const list = (videos ?? []).filter((v) => v.article?.complete).filter(fromChannel(channel));
  return (
    <>
      <PageHeader title={t("Articles")} description={t("Everything ready to read, newest first.")}>
        <ChannelFilter value={channel} onChange={setChannel} channels={channels} />
      </PageHeader>
      {!videos ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : list.length === 0 ? (
        <Empty title={t("No finished articles")}>{channel === "all" ? t("Paste a video on the home page or follow a channel to get started.") : t("No articles from this channel yet.")}</Empty>
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((v) => {
            const read = readMinutes(v)!;
            return (
              <a key={v.id} href={`#/videos/${v.id}`} className="group rise flex flex-col overflow-hidden rounded-2xl border bg-card shadow-(--shadow-card) transition-transform hover:-translate-y-0.5">
                <VideoThumb video={v} className="rounded-none" />
                <div className="flex flex-1 flex-col p-5">
                  <p className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{origin(v)}</p>
                  <h2 className="mt-1.5 line-clamp-3 font-display text-lg leading-snug font-semibold tracking-tight text-pretty group-hover:underline">{v.title ?? v.url}</h2>
                  <div className="mt-auto pt-5">
                    {v.durationSeconds != null && <Tape watchSeconds={v.durationSeconds} readMinutes={read} />}
                    <p className="mt-2 flex justify-between text-xs text-muted-foreground">
                      <span>
                        <strong className="font-semibold text-foreground">{read} min</strong> {t("of reading")} </span>
                      <span>{relative(v.createdAt)}</span>
                    </p>
                  </div>
                </div>
              </a>
            );
          })}
        </div>
      )}
    </>
  );
}

export function VideosPage({ videos, channels }: { videos: VideoView[] | null; channels: ChannelView[] }) {
  const [channel, setChannel] = useState("all");
  const [state, setState] = useState("all");
  const list = (videos ?? []).filter(fromChannel(channel)).filter((v) => state === "all" || v.state === state);
  return (
    <>
      <PageHeader title={t("Videos")} description={t("Every video added to Recast, in any state.")}>
        <ChannelFilter value={channel} onChange={setChannel} channels={channels} />
        <Select value={state} onValueChange={setState}>
          <SelectTrigger className="w-44 bg-card" aria-label={t("Filter by state")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("All states")}</SelectItem>
            {Object.entries(VIDEO_STATE_LABEL).map(([k, label]) => (
              <SelectItem key={k} value={k}>
                {t(label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </PageHeader>
      {!videos ? (
        <Skeleton className="h-96 rounded-2xl" />
      ) : list.length === 0 ? (
        <Empty title={t("No videos")}>{videos.length ? t("No videos match these filters.") : t("Paste a video on the home page or follow a channel to get started.")}</Empty>
      ) : (
        <Panel className="rise overflow-hidden">
          <ul className="divide-y">
            {list.map((v) => (
              <li key={v.id}>
                <a href={`#/videos/${v.id}`} className="group grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-5 py-3 transition-colors hover:bg-surface-subtle md:grid-cols-[6.5rem_minmax(0,1fr)_11rem_7.5rem_6rem]">
                  <VideoThumb video={v} badge={false} className="rounded-md" />
                  <div className="min-w-0">
                    <p className="truncate font-semibold group-hover:underline">{v.title ?? v.url}</p>
                    <p className="truncate text-sm text-muted-foreground">{origin(v)}</p>
                  </div>
                  <div className="col-span-2 flex items-center gap-3 md:col-span-1 md:block">
                    <StageTrack video={v} className="md:w-full" />
                    <p className="truncate text-xs text-muted-foreground md:mt-1.5">{stageSummary(v)}</p>
                  </div>
                  <div className="hidden md:block">
                    <StateBadge state={v.state} />
                  </div>
                  <p className="hidden text-right text-xs text-muted-foreground md:block">
                    {v.durationSeconds != null && <span className="block font-mono text-[0.8125rem] text-foreground tabular-nums">{clock(v.durationSeconds)}</span>}
                    {relative(v.createdAt)}
                  </p>
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
