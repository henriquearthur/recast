import { t, translateMessage } from "../lib/i18n";
import { AlertTriangle, Pause, Play, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { ChannelView } from "../../server/channels";
import type { IgnoredPublication } from "../../server/detection";
import type { Stats } from "../../server/stats";
import { ChannelAvatar, Empty, PageHeader, Panel, PanelHeader } from "../components/recast";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { humanDuration, relative, shortDate } from "../lib/format";
import { api, useNow } from "../lib/live";
import { cn } from "../lib/utils";

const WHY: Record<string, string> = { short: "Short", live: "Live", members: "Members only", restricted: "Restricted" };

type Preview = { name: string; handle: string | null; imageUrl: string | null; alreadyAdded: boolean };

function AddChannel({ onAdded }: { onAdded: () => void }) {
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    await work().catch((e: Error) => setError(e.message));
    setBusy(false);
  };
  const resolve = () =>
    run(async () => {
      setPreview(null);
      setPreview(await api.send<Preview>("POST", "/api/channels/resolve", { input }));
    });
  const confirm = () =>
    run(async () => {
      await api.send("POST", "/api/channels", { input });
      toast.success(t("Now following {0}", preview?.name));
      setInput("");
      setPreview(null);
      onAdded();
    });
  return (
    <Panel className="rise p-6">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) void resolve();
        }}
      >
        <div className="relative flex-1">
          <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setPreview(null);
            }}
            placeholder={t("Channel URL or @handle")}
            aria-label={t("Channel URL or @handle")}
            aria-invalid={!!error}
            className="h-11 bg-card pl-9"
          />
        </div>
        <Button size="lg" variant="outline" disabled={busy || !input.trim()} className="h-11 rounded-lg">
          {busy && !preview ? t("Searching…") : t("Find channel")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-destructive">
          {translateMessage(error)}
        </p>
      )}
      {preview && (
        <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl bg-marker-soft p-4">
          <ChannelAvatar name={preview.name} imageUrl={preview.imageUrl} className="size-12" />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{preview.name}</p>
            <p className="text-sm text-muted-foreground">{preview.alreadyAdded ? t("You already follow this channel.") : (preview.handle ?? t("YouTube channel"))}</p>
          </div>
          {!preview.alreadyAdded && (
            <Button onClick={confirm} disabled={busy}> {t("Follow channel")} </Button>
          )}
        </div>
      )}
      <p className="mt-3 text-xs text-muted-foreground">{t("Only videos published after you start following are processed. Shorts, livestreams, and members-only videos are excluded.")}</p>
    </Panel>
  );
}

function Instructions({ channel }: { channel: ChannelView }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(channel.instructions ?? "");
  useEffect(() => setText(channel.instructions ?? ""), [channel.instructions, open]);
  const save = () =>
    api.send("PATCH", `/api/channels/${channel.id}`, { instructions: text }).then(
      () => {
        toast.success(t("Instructions saved"));
        setOpen(false);
      },
      (e: Error) => toast.error(translateMessage(e.message)),
    );
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <SlidersHorizontal /> {t("Instructions")}{channel.instructions ? " · 1" : ""}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Instructions for")} {channel.name}</DialogTitle>
          <DialogDescription>{t("Guidance for this channel's articles. It complements the Global Prompt without replacing it.")}</DialogDescription>
        </DialogHeader>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={t("For example: explain the intuition before formulas; skip sponsored segments.")} aria-label={t("Channel Instructions")} />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost">{t("Cancel")}</Button>
          </DialogClose>
          <Button onClick={save}>{t("Save instructions")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChannelCard({ channel, stat, onChange }: { channel: ChannelView; stat?: Stats["channels"][number]; onChange: () => void }) {
  const now = useNow();
  const paused = channel.status === "paused";
  const act = (action: "pause" | "resume", done: string) => () => api.send("POST", `/api/channels/${channel.id}/${action}`).then(() => (toast.success(done), onChange()), (e: Error) => toast.error(translateMessage(e.message)));
  const remove = () => api.send("DELETE", `/api/channels/${channel.id}`).then(() => (toast.success(t("{0} removed", channel.name)), onChange()), (e: Error) => toast.error(translateMessage(e.message)));
  return (
    <Panel className="rise flex flex-col p-5">
      <div className="flex items-start gap-3">
        <ChannelAvatar name={channel.name} imageUrl={channel.imageUrl} className="size-11" />
        <div className="min-w-0 flex-1">
          <h2 className="truncate font-display text-lg leading-tight font-semibold tracking-tight">{channel.name}</h2>
          <p className="truncate text-sm text-muted-foreground">{channel.handle ?? "YouTube"}</p>
        </div>
        <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-semibold", paused ? "bg-muted text-muted-foreground" : "bg-positive-soft text-positive-foreground")}>
          <span className={cn("size-1.5 rounded-full", paused ? "bg-muted-foreground" : "bg-good")} />
          {paused ? t("Paused") : t("Following")}
        </span>
      </div>
      <dl className="mt-5 grid grid-cols-3 gap-3 border-y py-4">
        {[
          [String(stat?.videos ?? 0), t("videos")],
          [String(stat?.articles ?? 0), t("articles")],
          [stat?.watchSeconds ? humanDuration(stat.watchSeconds) : "—", t("of video read")],
        ].map(([value, label]) => (
          <div key={label}>
            <dd className="font-display text-xl leading-none font-semibold tracking-tight">{value}</dd>
            <dt className="mt-1 text-xs text-muted-foreground">{label}</dt>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm text-muted-foreground">
        {paused
          ? t("Checks stop while paused. Videos published during the pause are excluded.")
          : t("{0} · next check {1}", channel.lastCheckedAt ? t("Checked {0}", relative(channel.lastCheckedAt, now)) : t("Not checked yet"), channel.nextCheckAt && channel.nextCheckAt > now ? relative(channel.nextCheckAt, now) : t("shortly"))}
      </p>
      {channel.lastError && (
        <p role="alert" className="mt-3 flex gap-2 rounded-lg bg-danger-soft px-3 py-2 text-[0.8125rem] text-danger-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{translateMessage(channel.lastError)}</span>
        </p>
      )}
      <div className="mt-auto flex flex-wrap gap-2 pt-5">
        <Instructions channel={channel} />
        <Button variant="outline" size="sm" onClick={paused ? act("resume", t("Following {0} again", channel.name)) : act("pause", t("{0} paused", channel.name))}>
          {paused ? <Play /> : <Pause />} {paused ? t("Resume") : t("Pause")}
        </Button>
        <Dialog>
          <DialogTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto text-destructive hover:bg-danger-soft hover:text-destructive">
              <Trash2 /> {t("Remove")} </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("Remove")} {channel.name}?</DialogTitle>
              <DialogDescription>{t("Recast will stop checking this channel. Existing videos and articles are kept.")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button variant="ghost">{t("Keep channel")}</Button>
              </DialogClose>
              <DialogClose asChild>
                <Button variant="destructive" onClick={remove}> {t("Remove channel")} </Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </Panel>
  );
}

export function ChannelsPage({ channels, reload, stats }: { channels: ChannelView[] | null; reload: () => void; stats: Stats | null }) {
  const [ignored, setIgnored] = useState<IgnoredPublication[]>([]);
  useEffect(() => void api.get<IgnoredPublication[]>("/api/ignored").then(setIgnored), [channels]);
  const reasons = Object.entries(Object.groupBy(ignored, (i) => i.why)).map(([why, list]) => [why, list!.length] as const).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <PageHeader title={t("Channels")} description={t("YouTube channels you follow. Each is checked every 15 minutes.")} />
      <div className="space-y-5">
        <AddChannel onAdded={reload} />
        {!channels ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : channels.length === 0 ? (
          <Empty title={t("No channels followed")}>{t("Find a channel above. Each new video will automatically become an article.")}</Empty>
        ) : (
          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {channels.map((c) => (
              <ChannelCard key={c.id} channel={c} stat={stats?.channels.find((s) => s.channelId === c.id)} onChange={reload} />
            ))}
          </div>
        )}
        {ignored.length > 0 && (
          <Panel className="rise overflow-hidden">
            <PanelHeader title={t("Excluded publications")} hint={t("Channel publications that Recast does not turn into articles.")}>
              <ul className="flex flex-wrap gap-2">
                {reasons.map(([why, count]) => (
                  <li key={why} className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">
                    {t(WHY[why] ?? why)} <span className="ml-1 font-mono tabular-nums">{count}</span>
                  </li>
                ))}
              </ul>
            </PanelHeader>
            <ul className="mt-4 divide-y border-t">
              {ignored.map((i) => (
                <li key={i.youtubeId} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-6 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_10rem_6.5rem_4.5rem]">
                  <a href={`https://www.youtube.com/watch?v=${i.youtubeId}`} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline" title={translateMessage(i.reason)}>
                    {i.title ?? i.youtubeId}
                  </a>
                  <span className="hidden truncate text-muted-foreground sm:block">{i.channelName}</span>
                  <span className="justify-self-start rounded-full border px-2 py-px text-xs font-medium">{t(WHY[i.why] ?? i.why)}</span>
                  <span className="hidden text-right text-xs text-muted-foreground sm:block">{shortDate(i.publishedAt)}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

