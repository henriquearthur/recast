/** The yt-dlp metadata fields that decide what a publication is (`yt-dlp -J --ignore-no-formats-error`). */
export interface PublicationInfo {
  channel_id?: string | null;
  channel?: string | null;
  title?: string | null;
  duration?: number | null;
  availability?: string | null;
  media_type?: string | null;
  live_status?: string | null;
  was_live?: boolean | null;
  /** When it was published, in epoch seconds. */
  timestamp?: number | null;
  /** The publication day as `YYYYMMDD`, for when there is no `timestamp`. */
  upload_date?: string | null;
}

export type IgnoredWhy = "short" | "live" | "members" | "restricted";

/** Why a publication is never a Video, as told to the user. */
export const IGNORED_REASON: Record<IgnoredWhy, string> = {
  members: "This video is exclusive to channel members.",
  restricted: "This video is not public (private or restricted).",
  short: "This is a Short; Recast only processes ordinary videos.",
  live: "This is a livestream (ongoing or completed); Recast only processes ordinary videos.",
};
const ignored = (why: IgnoredWhy): Classification => ({ kind: "ignored", why, reason: IGNORED_REASON[why] });

export type Classification =
  | { kind: "video" }
  /** Not available yet (a premiere or scheduled live): ask again later. */
  | { kind: "deferred"; reason: string }
  /** Never a Video: refused for good. */
  | { kind: "ignored"; why: IgnoredWhy; reason: string }
  /** The metadata came back empty (private, removed or blocked): an error to retry, never an ordinary video. */
  | { kind: "unreadable"; reason: string };

/** The one rule that says whether a publication is a Video; shared by the ad hoc request and Channel detection. */
export function classifyPublication(info: PublicationInfo): Classification {
  if (!info.channel_id)
    return { kind: "unreadable", reason: "Could not read video metadata (private, removed, or unavailable)." };
  if (info.availability && info.availability !== "public" && info.availability !== "unlisted") {
    return info.availability === "subscriber_only"
      ? ignored("members")
      : ignored("restricted");
  }
  if (info.media_type === "short")
    return ignored("short");
  // UNVERIFIED against a real premiere (none was available to record): a premiere in progress is assumed to report
  // `is_live` with `media_type: "video"`, whereas every real live seen reports `media_type: "livestream"`.
  const premiereInProgress = info.live_status === "is_live" && info.media_type === "video";
  if (info.live_status === "is_upcoming" || premiereInProgress)
    return { kind: "deferred", reason: "This publication is not available yet (scheduled premiere or livestream)." };
  if (info.live_status === "is_live" || info.live_status === "was_live" || info.was_live || info.media_type === "livestream")
    return ignored("live");
  return { kind: "video" };
}

/** The Video's length in whole seconds, when the metadata has one. */
export const durationSeconds = (info: PublicationInfo): number | null => (info.duration != null ? Math.round(info.duration) : null);

/** When the Video was published (epoch ms), when the metadata says so. */
export function publishedAt(info: PublicationInfo): number | null {
  if (info.timestamp != null) return info.timestamp * 1000;
  const day = info.upload_date?.match(/^(\d{4})(\d{2})(\d{2})$/);
  return day ? Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 12) : null;
}
