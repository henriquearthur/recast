import type { Database } from "bun:sqlite";
import { parseArticle } from "../article";
import { STAGES, type Stage } from "./pipeline";

export interface Stats {
  /** Every Video that entered the pipeline, whatever became of it. */
  videos: number;
  /** Videos with a finished Article; the three numbers below are about these. */
  articles: number;
  watchSeconds: number;
  readWords: number;
  /** One entry per local day (`YYYY-MM-DD`) with anything in it, oldest first. Videos count on the day they entered. */
  daily: { day: string; videos: number; articles: number; watchSeconds: number; readWords: number; credits: number; inputTokens: number; outputTokens: number }[];
  /** How the runs of each Stage went; `avgMs` is the mean duration of the ones that finished. */
  stages: { stage: Stage; done: number; failed: number; avgMs: number | null }[];
  /** `channelId: null` is the group of ad hoc videos. */
  channels: { channelId: number | null; name: string | null; videos: number; articles: number; watchSeconds: number; readWords: number }[];
}

/** `YYYY-MM-DD` of a moment in the server's local time zone. */
const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** What Recast has produced so far, for the charts of the UI. Computed on demand from the same tables everything else reads. */
export function stats(db: Database): Stats {
  const videos = db
    .query<{ at: number; channelId: number | null; origin: string; name: string | null; seconds: number | null; markdown: string | null }, []>(
      `SELECT v.created_at AS at, v.channel_id AS channelId, v.origin, v.channel_name AS name, v.duration_seconds AS seconds, a.markdown
       FROM videos v LEFT JOIN articles a ON a.video_id = v.id AND a.complete = 1 ORDER BY v.id`,
    )
    .all();
  const daily = new Map<string, Stats["daily"][number]>();
  const day = (ms: number) => {
    const key = localDay(ms);
    if (!daily.has(key)) daily.set(key, { day: key, videos: 0, articles: 0, watchSeconds: 0, readWords: 0, credits: 0, inputTokens: 0, outputTokens: 0 });
    return daily.get(key)!;
  };
  const channels = new Map<number | null, Stats["channels"][number]>();
  const total = { videos: 0, articles: 0, watchSeconds: 0, readWords: 0 };
  for (const v of videos) {
    const channelId = v.origin === "ad_hoc" ? null : v.channelId;
    if (!channels.has(channelId)) channels.set(channelId, { channelId, name: channelId === null ? null : v.name, videos: 0, articles: 0, watchSeconds: 0, readWords: 0 });
    for (const group of [total, day(v.at), channels.get(channelId)!]) {
      group.videos += 1;
      if (v.markdown === null) continue;
      group.articles += 1;
      group.watchSeconds += v.seconds ?? 0;
      group.readWords += parseArticle(v.markdown).words;
    }
  }
  for (const u of db.query<{ at: number; i: number; o: number; credits: number }, []>("SELECT created_at AS at, input_tokens AS i, output_tokens AS o, credits FROM usage_records").all()) {
    const d = day(u.at);
    d.credits += u.credits;
    d.inputTokens += u.i;
    d.outputTokens += u.o;
  }
  const runs = db
    .query<{ stage: Stage; done: number; failed: number; avgMs: number | null }, []>(
      `SELECT stage, sum(status = 'done') AS done, sum(status = 'failed') AS failed,
              avg(CASE WHEN status = 'done' AND started_at IS NOT NULL THEN finished_at - started_at END) AS avgMs
       FROM stage_runs GROUP BY stage`,
    )
    .all();
  return {
    ...total,
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    stages: STAGES.map((stage) => runs.find((r) => r.stage === stage) ?? { stage, done: 0, failed: 0, avgMs: null }),
    channels: [...channels.values()].sort((a, b) => b.watchSeconds - a.watchSeconds),
  };
}
