import { t } from "../lib/i18n";
import { AlertTriangle, Ban, Check, CircleDashed, Loader2, Play } from "lucide-react";
import type { ReactNode } from "react";
import type { VideoView } from "../../server/pipeline";
import { STAGE_LABEL, STATUS_LABEL, VIDEO_STATE_LABEL } from "../labels";
import { clock, humanDuration, initials, thumbnail } from "../lib/format";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/** Lines of text arranged as a play button: a video, turned into reading. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-8", className)} aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <g stroke="var(--marker)" strokeWidth="2.6" strokeLinecap="round">
        <path d="M10 9.5h3M10 13.8h8M10 18.2h8M10 22.5h3M10 16h13" />
      </g>
    </svg>
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("text-[0.6875rem] font-semibold tracking-[0.14em] text-muted-foreground uppercase", className)}>{children}</p>;
}

export function PageHeader({ title, description, children }: { title: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <header className="rise mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="font-display text-[2rem] leading-tight font-bold tracking-tight sm:text-[2.5rem]">{title}</h1>
        {description && <p className="mt-2 text-[0.9375rem] text-muted-foreground">{description}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

export function Panel({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn("rounded-2xl border bg-card shadow-(--shadow-card)", className)}>{children}</section>;
}

export function PanelHeader({ title, hint, children }: { title: string; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 px-6 pt-5">
      <div>
        <h2 className="font-display text-lg leading-tight font-semibold tracking-tight">{title}</h2>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export function Empty({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-2xl border border-dashed px-6 py-12 text-center", className)}>
      <p className="font-display text-lg font-semibold">{title}</p>
      {children && <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</p>}
    </div>
  );
}

export function VideoThumb({ video, className, badge = true }: { video: Pick<VideoView, "youtubeId" | "durationSeconds">; className?: string; badge?: boolean }) {
  return (
    <div className={cn("relative aspect-video shrink-0 overflow-hidden rounded-lg bg-muted", className)}>
      <img src={thumbnail(video.youtubeId)} alt="" loading="lazy" className="size-full object-cover" />
      {badge && video.durationSeconds != null && (
        <span className="absolute right-1 bottom-1 rounded bg-ink/85 px-1 py-px font-mono text-[0.625rem] font-medium text-white">{clock(video.durationSeconds)}</span>
      )}
    </div>
  );
}

export function ChannelAvatar({ name, imageUrl, className }: { name: string; imageUrl?: string | null; className?: string }) {
  return imageUrl ? (
    <img src={imageUrl} alt="" className={cn("size-10 shrink-0 rounded-full bg-muted object-cover", className)} />
  ) : (
    <span className={cn("grid size-10 shrink-0 place-items-center rounded-full bg-ink font-display text-sm font-semibold text-marker", className)} aria-hidden>
      {initials(name)}
    </span>
  );
}

const STATE_STYLE: Record<VideoView["state"], { icon: typeof Check; className: string }> = {
  in_progress: { icon: Loader2, className: "bg-foreground text-primary-foreground" },
  completed: { icon: Check, className: "bg-positive-soft text-positive-foreground" },
  failed: { icon: AlertTriangle, className: "bg-danger-soft text-danger-foreground" },
  cancelled: { icon: Ban, className: "bg-muted text-muted-foreground" },
};

/** A Video's state, always as icon and words. */
export function StateBadge({ state, className }: { state: VideoView["state"]; className?: string }) {
  const { icon: Icon, className: style } = STATE_STYLE[state];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold whitespace-nowrap", style, className)}>
      <Icon className={cn("size-3", state === "in_progress" && "animate-spin")} strokeWidth={2.5} />
      {t(VIDEO_STATE_LABEL[state]!)}
    </span>
  );
}

const SEGMENT: Record<string, string> = {
  waiting: "bg-segment",
  running: "bg-segment",
  done: "bg-foreground",
  failed: "bg-critical",
  cancelled: "bg-cancelled",
};

/** The four Stages of a Video as four segments: filled when done, filling while running. */
export function StageTrack({ video, className }: { video: VideoView; className?: string }) {
  return (
    <div className={cn("flex w-28 gap-0.5", className)} role="img" aria-label={video.stages.map((s) => `${t(STAGE_LABEL[s.stage]!)}: ${t(STATUS_LABEL[s.status]!)}`).join(", ")}>
      {video.stages.map((s) => (
        <Tooltip key={s.stage}>
          <TooltipTrigger asChild>
            <span className={cn("relative h-1.5 flex-1 overflow-hidden rounded-full", SEGMENT[s.status])}>
              {s.status === "running" && <span className="absolute inset-y-0 left-0 rounded-full bg-foreground transition-[width] duration-500" style={{ width: `${Math.max(8, s.percent ?? 0)}%` }} />}
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {t(STAGE_LABEL[s.stage]!)}: {s.status === "running" ? `${Math.round(s.percent ?? 0)}%` : t(STATUS_LABEL[s.status]!).toLowerCase()}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

/** Where a Video is, in words: the first Stage not done, or the ready label. */
export function stageSummary(video: VideoView) {
  const s = video.stages.find((s) => s.status !== "done");
  if (!s) return t("Delivered");
  if (s.status === "running") return `${t(STAGE_LABEL[s.stage]!)} · ${Math.round(s.percent ?? 0)}%`;
  if (s.status === "waiting") return s.queuePosition ? t("{0} · queue position {1}", t(STAGE_LABEL[s.stage]!), s.queuePosition) : t("{0} · waiting", t(STAGE_LABEL[s.stage]!));
  return `${t(STAGE_LABEL[s.stage]!)} · ${t(STATUS_LABEL[s.status]!).toLowerCase()}`;
}

/**
 * Watching time against reading time, as lengths on the same scale: the grey tape is the video, the highlighted
 * stretch is the Article. `large` adds the ruler and the labels.
 */
export function Tape({ watchSeconds, readMinutes, large = false, className }: { watchSeconds: number; readMinutes: number; large?: boolean; className?: string }) {
  const share = watchSeconds > 0 ? Math.min(100, Math.max(large ? 1.5 : 4, ((readMinutes * 60) / watchSeconds) * 100)) : 100;
  const label = t("{0} reading time for {1} of video", humanDuration(readMinutes * 60), humanDuration(watchSeconds));
  if (!large)
    return (
      <div className={cn("h-1.5 overflow-hidden rounded-full bg-(--chart-watch)/45", className)} role="img" aria-label={label}>
        <div className="h-full rounded-full bg-(--chart-read)" style={{ width: `${share}%` }} />
      </div>
    );
  return (
    <div className={className} role="img" aria-label={label}>
      <div className="relative h-12 overflow-hidden rounded-lg bg-track">
        <div className="ruler absolute inset-0 opacity-60" />
        <div className="grow absolute inset-y-0 left-0 rounded-lg bg-marker" style={{ width: `${share}%` }}>
          <div className="ruler absolute inset-0 opacity-40 [--ruler:var(--ink)]" style={{ ["--tick" as string]: `${250 / share}%` }} />
        </div>
      </div>
      <div className="mt-2 flex justify-between gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <span className="size-2 rounded-sm bg-marker ring-1 ring-foreground/15" /> {t("Reading ·")} {humanDuration(readMinutes * 60)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2 rounded-sm bg-(--chart-watch)" /> {t("Video ·")} {humanDuration(watchSeconds)}
        </span>
      </div>
    </div>
  );
}

/** A trend in one line: the last point is the one that matters, so it is the only one marked. */
export function Sparkline({ values, className, color = "var(--chart-read)" }: { values: number[]; className?: string; color?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1e-9);
  const x = (i: number) => 2 + (i / (values.length - 1)) * 96;
  const y = (v: number) => 26 - (v / max) * 22;
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className={cn("h-8 w-full overflow-visible", className)} aria-hidden>
      <path d={`${line} L98 28 L2 28 Z`} fill={color} opacity="0.1" />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatTile({ label, value, unit, note, children }: { label: string; value: string; unit?: string; note?: ReactNode; children?: ReactNode }) {
  return (
    <Panel className="flex flex-col justify-between gap-4 p-5">
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="mt-1.5 font-display text-[2rem] leading-none font-semibold tracking-tight">
          {value}
          {unit && <span className="ml-1.5 font-sans text-sm font-medium tracking-normal text-muted-foreground">{unit}</span>}
        </p>
        {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
      </div>
      {children}
    </Panel>
  );
}

export function WatchLink({ url, className }: { url: string; className?: string }) {
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cn("inline-flex items-center gap-1 text-sm font-medium text-pine hover:underline", className)}>
      <Play className="size-3.5 fill-current" /> {t("Watch on YouTube")} </a>
  );
}

export { CircleDashed };
