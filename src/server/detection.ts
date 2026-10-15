import type { Database } from "bun:sqlite";
import { classifyPublication, durationSeconds, IGNORED_REASON, publishedAt, type IgnoredWhy } from "./classify";
import type { ChannelRow, Channels } from "./channels";
import type { Clock } from "./clock";
import { PublicationUnavailableError, type Deps, type ListedPublication } from "./deps";
import { errorMessage } from "./errors";
import type { Pipeline } from "./pipeline";
import { withTimeout } from "./timeout";

/** How long a feed fetch or a metadata lookup may take before the check gives up on it. */
export const LOOKUP_TIMEOUT_MS = 60_000;
const TIMED_OUT = `The request timed out (${LOOKUP_TIMEOUT_MS / 1000} s).`;

export interface IgnoredPublication {
  youtubeId: string;
  title: string | null;
  channelId: number;
  channelName: string;
  publishedAt: number;
  why: IgnoredWhy;
  reason: string;
}

/**
 * Detection: every active Channel is checked every 15 minutes through its public feed, all of them at once, so a slow
 * one never delays the others. A publication enters the pipeline when it is newer than the Channel's "active since"
 * mark and classifies as a Video. A failed lookup is never a verdict: the publication is simply tried again at the
 * next check.
 */
export class Detection {
  private scheduledWakeUps = new Set<number>();
  private checking = new Map<number, { channel: ChannelRow; invalidated: boolean }>();
  private stopped = false;

  constructor(
    private db: Database,
    private deps: Deps,
    private clock: Clock,
    private channels: Channels,
    private pipeline: Pipeline,
  ) {
    channels.subscribe((event) => {
      const id = event.type === "removed" ? event.id : event.channel.id;
      const check = this.checking.get(id);
      if (check && (event.type === "removed" || event.channel.status !== "active" || event.channel.activeSince !== check.channel.active_since))
        check.invalidated = true;
      this.scheduleNextCheck();
    });
  }

  stop() {
    this.stopped = true;
  }

  ignored(channelId?: number): IgnoredPublication[] {
    return this.db
      .query<IgnoredPublication, [number | null, number | null]>(
        `SELECT youtube_id AS youtubeId, title, channel_id AS channelId, channel_name AS channelName,
                published_at AS publishedAt, why, reason
         FROM ignored_publications WHERE (? IS NULL OR channel_id = ?) ORDER BY published_at DESC, youtube_id`,
      )
      .all(channelId ?? null, channelId ?? null);
  }

  /** Checks every active Channel that is due, all at once; a failure in one never reaches the others. */
  async tick() {
    if (this.stopped) return;
    await Promise.all(this.channels.due().map((channel) => this.check(channel)));
    this.scheduleNextCheck();
  }

  /** Wakes up at the earliest next check. Safe to call at any time; a wake-up with nothing due does nothing. */
  scheduleNextCheck() {
    if (this.stopped) return;
    const pending = this.channels.list().filter((c) => c.status === "active" && !this.checking.has(c.id));
    if (!pending.length) return;
    const next = Math.min(...pending.map((c) => c.nextCheckAt ?? 0));
    const at = Math.max(next, this.clock.now());
    if (this.scheduledWakeUps.has(at)) return;
    this.scheduledWakeUps.add(at);
    void this.clock.sleep(at - this.clock.now()).then(() => {
      this.scheduledWakeUps.delete(at);
      return this.tick();
    });
  }

  private async check(channel: ChannelRow) {
    if (this.checking.has(channel.id)) return;
    const check = { channel, invalidated: false };
    this.checking.set(channel.id, check);
    let error: string | null = null;
    try {
      error = await this.detect(channel, () => this.isCurrent(check));
    } catch (err) {
      error = `Could not read the channel feed: ${errorMessage(err)}`;
    } finally {
      this.checking.delete(channel.id);
    }
    if (this.isCurrent(check)) this.channels.recordCheck(channel.id, error);
  }

  /** A pause invalidates the generation even when an immediate resume uses the same timestamp. */
  private isCurrent(check: { channel: ChannelRow; invalidated: boolean }): boolean {
    if (this.stopped || check.invalidated) return false;
    const current = this.channels.view(check.channel.id);
    return current?.status === "active" && current.activeSince === check.channel.active_since;
  }

  private hasOutcome(youtubeId: string) {
    return (
      this.pipeline.findByYoutubeId(youtubeId) !== null ||
      this.db.query("SELECT 1 FROM ignored_publications WHERE youtube_id = ?").get(youtubeId) !== null
    );
  }

  /** Returns the error to show on the Channel, or null when everything went through. */
  private async detect(channel: ChannelRow, isCurrent: () => boolean): Promise<string | null> {
    const feed = await withTimeout(this.clock, LOOKUP_TIMEOUT_MS, TIMED_OUT, (signal) =>
      this.deps.feed.fetchFeed(channel.youtube_id, signal),
    );
    if (!isCurrent()) return null;
    // Oldest first, so Videos enter in publication order.
    const fresh = feed.filter((p) => p.publishedAt > channel.active_since).sort((a, b) => a.publishedAt - b.publishedAt);
    let unreadable: string | null = null;
    for (const publication of fresh) {
      if (!isCurrent()) return null;
      if (this.hasOutcome(publication.youtubeId)) continue;
      if (publication.isShort) {
        this.ignore(channel, publication, "short", IGNORED_REASON.short);
        continue;
      }
      let info, verdict;
      try {
        info = await withTimeout(this.clock, LOOKUP_TIMEOUT_MS, TIMED_OUT, (signal) =>
          this.deps.metadata.lookup(publication.youtubeId, signal),
        );
        if (!isCurrent()) return null;
        verdict = classifyPublication(info);
      } catch (err) {
        if (!isCurrent()) return null;
        const error = `Could not look up video ${publication.youtubeId}: ${errorMessage(err)}`;
        if (err instanceof PublicationUnavailableError) {
          unreadable ??= error;
          continue;
        }
        // Global blocking/offline: leave the remaining publications for the next check instead of bursting.
        return error;
      }
      // Empty metadata is about this one publication (private, removed): keep going with the newer ones.
      if (verdict.kind === "unreadable") unreadable ??= `Video ${publication.youtubeId}: ${verdict.reason}`;
      if (verdict.kind === "ignored") this.ignore(channel, publication, verdict.why, verdict.reason);
      if (verdict.kind === "video")
        this.pipeline.request(publication.youtubeId, `https://www.youtube.com/watch?v=${publication.youtubeId}`, {
          title: info.title ?? publication.title,
          channelName: channel.name,
          durationSeconds: durationSeconds(info),
          publishedAt: publishedAt(info) ?? publication.publishedAt,
          channelId: channel.id,
        });
      // Deferred: not stored; it is still in the feed and is asked about again at the next check.
    }
    return unreadable;
  }

  private ignore(channel: ChannelRow, publication: ListedPublication, why: IgnoredWhy, reason: string) {
    this.db
      .query("INSERT OR IGNORE INTO ignored_publications (youtube_id, channel_id, channel_name, title, published_at, why, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(publication.youtubeId, channel.id, channel.name, publication.title, publication.publishedAt, why, reason, this.clock.now());
  }
}
