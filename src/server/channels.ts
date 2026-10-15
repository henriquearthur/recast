import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import type { ChannelResolver, ResolvedChannel } from "./deps";

export const CHECK_INTERVAL_MS = 15 * 60_000;

export interface ChannelRow {
  id: number;
  youtube_id: string;
  name: string;
  handle: string | null;
  image_url: string | null;
  status: "active" | "paused";
  active_since: number;
  last_checked_at: number | null;
  next_check_at: number | null;
  last_error: string | null;
  instructions: string | null;
}

export interface ChannelView {
  id: number;
  youtubeChannelId: string;
  name: string;
  handle: string | null;
  imageUrl: string | null;
  status: "active" | "paused";
  /** Only publications after this moment enter the pipeline. */
  activeSince: number;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  lastError: string | null;
  /** Complement the Global Prompt for this Channel's Articles. */
  instructions: string | null;
}

export type ChannelEvent = { type: "changed"; channel: ChannelView } | { type: "removed"; id: number };

const toView = (c: ChannelRow): ChannelView => ({
  id: c.id,
  youtubeChannelId: c.youtube_id,
  name: c.name,
  handle: c.handle,
  imageUrl: c.image_url,
  status: c.status,
  activeSince: c.active_since,
  lastCheckedAt: c.last_checked_at,
  nextCheckAt: c.next_check_at,
  lastError: c.last_error,
  instructions: c.instructions,
});

/**
 * The followed Channels: adding, pausing, resuming, removing and their Instructions. Every change is announced to the
 * subscribers (detection listens, to wake up in time for a check that a change has just moved).
 */
export class Channels {
  private listeners = new Set<(event: ChannelEvent) => void>();

  constructor(
    private db: Database,
    private resolver: ChannelResolver,
    private clock: Clock,
  ) {}

  subscribe(listener: (event: ChannelEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: ChannelEvent) {
    for (const l of this.listeners) l(event);
  }

  list(): ChannelView[] {
    return this.db.query<ChannelRow, []>("SELECT * FROM channels ORDER BY id").all().map(toView);
  }

  view(id: number): ChannelView | null {
    const row = this.db.query<ChannelRow, [number]>("SELECT * FROM channels WHERE id = ?").get(id);
    return row ? toView(row) : null;
  }

  /** Blank instructions clear them. Returns null when the Channel does not exist. */
  setInstructions(id: number, instructions: string): ChannelView | null {
    this.db.query("UPDATE channels SET instructions = ? WHERE id = ?").run(instructions.trim() || null, id);
    return this.announce(id);
  }

  /** Resolves a pasted URL or @handle and says whether that Channel is already followed. Adds nothing. */
  async resolve(input: string): Promise<ResolvedChannel & { alreadyAdded: boolean }> {
    const resolved = await this.resolver.resolve(input);
    return { ...resolved, alreadyAdded: this.findByYoutubeId(resolved.channelId) !== null };
  }

  /** Follows the Channel from now on; nothing it already published is processed. "exists" when it is already followed. */
  async add(input: string): Promise<ChannelView | "exists"> {
    const resolved = await this.resolver.resolve(input);
    if (this.findByYoutubeId(resolved.channelId)) return "exists";
    const now = this.clock.now();
    const { id } = this.db
      .query<{ id: number }, [string, string, string | null, string | null, number, number, number]>(
        "INSERT INTO channels (youtube_id, name, handle, image_url, active_since, next_check_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
      )
      .get(resolved.channelId, resolved.name, resolved.handle, resolved.imageUrl, now, now + CHECK_INTERVAL_MS, now)!;
    return this.announce(id)!;
  }

  /** Stops checking the Channel; what it already sent into the pipeline carries on. `null` when it does not exist. */
  pause(id: number): ChannelView | null {
    this.db.query("UPDATE channels SET status = 'paused' WHERE id = ?").run(id);
    return this.announce(id);
  }

  /**
   * Follows the Channel again from now on: what it published during the pause is never processed. A Channel that is
   * already active is left as it is, so the "active since" mark never moves forward past publications still to come.
   */
  resume(id: number): ChannelView | null {
    const current = this.view(id);
    if (!current || current.status === "active") return current;
    const now = this.clock.now();
    this.db
      .query("UPDATE channels SET status = 'active', active_since = ?, next_check_at = ?, last_error = NULL WHERE id = ?")
      .run(now, now + CHECK_INTERVAL_MS, id);
    return this.announce(id);
  }

  /**
   * Ends the following. Videos and Articles stay, keeping their `channel_name`; their `channel_id` is left dangling
   * (ids are never reused), so the costs page still groups them under the removed Channel's name.
   */
  remove(id: number): boolean {
    const removed = this.db.query("DELETE FROM channels WHERE id = ?").run(id).changes > 0;
    if (removed) this.emit({ type: "removed", id });
    return removed;
  }

  /** The active Channels whose check is due. */
  due(): ChannelRow[] {
    return this.db
      .query<ChannelRow, [number]>("SELECT * FROM channels WHERE status = 'active' AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY id")
      .all(this.clock.now());
  }

  /** The earliest moment any active Channel is due, or null when none is followed. */
  nextCheckAt(): number | null {
    return (
      this.db
        .query<{ at: number | null }, []>("SELECT MIN(COALESCE(next_check_at, 0)) AS at FROM channels WHERE status = 'active'")
        .get()?.at ?? null
    );
  }

  /** Records the outcome of a check and schedules the next one. */
  recordCheck(id: number, error: string | null) {
    const now = this.clock.now();
    this.db
      .query("UPDATE channels SET last_checked_at = ?, next_check_at = ?, last_error = ? WHERE id = ?")
      .run(now, now + CHECK_INTERVAL_MS, error, id);
    this.announce(id);
  }

  private announce(id: number): ChannelView | null {
    const channel = this.view(id);
    if (channel) this.emit({ type: "changed", channel });
    return channel;
  }

  private findByYoutubeId(youtubeId: string) {
    return this.db.query<{ id: number }, [string]>("SELECT id FROM channels WHERE youtube_id = ?").get(youtubeId);
  }
}
