import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { IGNORED_REASON } from "./classify";

export function openDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(join(dataDir, "recast.db"), { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id TEXT NOT NULL UNIQUE,
    url TEXT NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    title TEXT,
    channel_name TEXT,
    duration_seconds INTEGER
  )`);
  for (const column of ["title", "channel_name", "duration_seconds"]) {
    if (!db.query("SELECT 1 FROM pragma_table_info('videos') WHERE name = ?").get(column))
      db.run(`ALTER TABLE videos ADD COLUMN ${column} ${column === "duration_seconds" ? "INTEGER" : "TEXT"}`);
  }
  // When YouTube published the video (epoch ms); NULL for videos requested before this was recorded.
  if (!db.query("SELECT 1 FROM pragma_table_info('videos') WHERE name = 'published_at'").get())
    db.run("ALTER TABLE videos ADD COLUMN published_at INTEGER");
  // Set by Channel detection (#9) for videos that come from a Channel; NULL means an ad hoc video.
  if (!db.query("SELECT 1 FROM pragma_table_info('videos') WHERE name = 'channel_id'").get())
    db.run("ALTER TABLE videos ADD COLUMN channel_id INTEGER");
  // Where the video came from: 'channel' (detected) or 'ad_hoc' (requested by hand). Unlike channel_id it survives removing the Channel.
  if (!db.query("SELECT 1 FROM pragma_table_info('videos') WHERE name = 'origin'").get()) {
    db.run("ALTER TABLE videos ADD COLUMN origin TEXT NOT NULL DEFAULT 'ad_hoc'");
    db.run("UPDATE videos SET origin = 'channel' WHERE channel_id IS NOT NULL");
  }
  db.run("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  // A followed YouTube channel. Only publications after `active_since` enter the pipeline.
  db.run(`CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    handle TEXT,
    image_url TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    active_since INTEGER NOT NULL,
    last_checked_at INTEGER,
    next_check_at INTEGER,
    last_error TEXT,
    created_at INTEGER NOT NULL
  )`);
  // Channel Instructions (#12): complement the Global Prompt for this Channel's Articles; NULL means none.
  if (!db.query("SELECT 1 FROM pragma_table_info('channels') WHERE name = 'instructions'").get())
    db.run("ALTER TABLE channels ADD COLUMN instructions TEXT");
  // Publications the detection refused for good (Short, live, members...). Detected ones are rows of `videos`.
  // `channel_id` points at channels(id) without a constraint: removing a Channel keeps its history.
  db.run(`CREATE TABLE IF NOT EXISTS ignored_publications (
    youtube_id TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL,
    channel_name TEXT NOT NULL,
    title TEXT,
    published_at INTEGER NOT NULL,
    why TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // One row per attempt of a stage. A waiting row is a place in that stage's FIFO queue.
  db.run(`CREATE TABLE IF NOT EXISTS stage_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    stage TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    percent REAL,
    detail TEXT,
    queued_at INTEGER NOT NULL,
    not_before INTEGER,
    started_at INTEGER,
    finished_at INTEGER,
    error TEXT,
    log TEXT NOT NULL DEFAULT '',
    output TEXT
  )`);
  // Generation selection is captured when the Article stage starts, and inherited by retries.
  if (!db.query("SELECT 1 FROM pragma_table_info('stage_runs') WHERE name = 'model'").get())
    db.run("ALTER TABLE stage_runs ADD COLUMN model TEXT");
  if (!db.query("SELECT 1 FROM pragma_table_info('stage_runs') WHERE name = 'provider'").get())
    db.run("ALTER TABLE stage_runs ADD COLUMN provider TEXT");
  db.run("CREATE INDEX IF NOT EXISTS stage_runs_queue ON stage_runs(stage, status, id)");
  // The Transcript: segments with times, in the original language (JSON array of {startMs, endMs, text}).
  db.run(`CREATE TABLE IF NOT EXISTS transcripts (
    video_id INTEGER PRIMARY KEY REFERENCES videos(id),
    language TEXT NOT NULL,
    segments TEXT NOT NULL
  )`);
  // The article of a video: filled chunk by chunk while the Article stage runs, replaced on regeneration.
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    video_id INTEGER PRIMARY KEY REFERENCES videos(id),
    markdown TEXT NOT NULL DEFAULT '',
    complete INTEGER NOT NULL DEFAULT 0
  )`);
  // While an Article is regenerated, the new text so far; the previous Article stays in `markdown` until it is complete.
  if (!db.query("SELECT 1 FROM pragma_table_info('articles') WHERE name = 'draft'").get())
    db.run("ALTER TABLE articles ADD COLUMN draft TEXT");
  // One immutable record per article generation (regenerations add more rows).
  db.run(`CREATE TABLE IF NOT EXISTS usage_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL REFERENCES videos(id),
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    credits REAL NOT NULL,
    created_at INTEGER NOT NULL
  )`);
  // Add metadata without rewriting immutable historical records. Old usage belongs to Copilot.
  for (const [name, type] of Object.entries({ provider: "TEXT NOT NULL DEFAULT 'copilot'", cached_input_tokens: "INTEGER NOT NULL DEFAULT 0", cost_usd: "REAL", cost_kind: "TEXT", cost_source: "TEXT", credits_known: "INTEGER NOT NULL DEFAULT 1", tokens_known: "INTEGER NOT NULL DEFAULT 1" })) {
    if (!db.query("SELECT 1 FROM pragma_table_info('usage_records') WHERE name = ?").get(name)) db.run(`ALTER TABLE usage_records ADD COLUMN ${name} ${type}`);
  }
  db.run(`CREATE TABLE IF NOT EXISTS provider_catalogs (provider TEXT PRIMARY KEY, models TEXT NOT NULL, updated_at INTEGER NOT NULL)`);
  // Link the displayed Article to its successful generation, independent of later failed/cancelled attempts.
  if (!db.query("SELECT 1 FROM pragma_table_info('articles') WHERE name = 'usage_record_id'").get()) {
    db.run("ALTER TABLE articles ADD COLUMN usage_record_id INTEGER REFERENCES usage_records(id)");
    db.run("UPDATE articles SET usage_record_id = (SELECT MAX(id) FROM usage_records WHERE video_id = articles.video_id) WHERE complete = 1");
  }
  db.run(`CREATE TRIGGER IF NOT EXISTS usage_records_no_update BEFORE UPDATE ON usage_records
    BEGIN SELECT RAISE(ABORT, 'usage records are immutable'); END`);
  db.run(`CREATE TRIGGER IF NOT EXISTS usage_records_no_delete BEFORE DELETE ON usage_records
    BEGIN SELECT RAISE(ABORT, 'usage records are immutable'); END`);
  // Schema version 1: English became the source language and the Article language a setting. Installations from
  // before it wrote every Article in Brazilian Portuguese, so they keep doing so, and stored reasons are restated.
  if (db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version < 1) {
    db.transaction(() => {
      if (db.query("SELECT 1 FROM videos UNION ALL SELECT 1 FROM channels UNION ALL SELECT 1 FROM settings LIMIT 1").get())
        db.run("INSERT OR IGNORE INTO settings (key, value) VALUES ('articleLanguage', 'pt-BR')");
      for (const [why, reason] of Object.entries(IGNORED_REASON)) db.query("UPDATE ignored_publications SET reason = ? WHERE why = ?").run(reason, why);
      db.run("PRAGMA user_version = 1");
    })();
  }
  return db;
}
