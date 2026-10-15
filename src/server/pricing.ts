import type { Database } from "bun:sqlite";
import type { ArticleUsage } from "./deps";

const SOURCE = "https://models.dev/api.json";
const TTL = 24 * 60 * 60_000;
/** Online reference prices provide an API-equivalent estimate, never subscription billing. */
export class CodexPricing {
  private pending: Promise<Record<string, unknown> | null> | undefined;
  constructor(private db: Database, private fetcher = fetch, private now = Date.now) {
    db.run("CREATE TABLE IF NOT EXISTS reference_prices (id INTEGER PRIMARY KEY CHECK(id = 1), data TEXT NOT NULL, fetched_at INTEGER NOT NULL)");
  }
  private async prices() {
    const cached = this.db.query<{ data: string; fetched_at: number }, []>("SELECT data, fetched_at FROM reference_prices WHERE id = 1").get();
    if (cached && this.now() - cached.fetched_at < TTL) return JSON.parse(cached.data) as Record<string, unknown>;
    if (this.pending) return this.pending;
    this.pending = (async () => {
      try {
        const response = await this.fetcher(SOURCE, { signal: AbortSignal.timeout(5000) });
        if (!response.ok) return null;
        const data = await response.json() as { openai?: { models?: Record<string, unknown> } };
        if (!data.openai?.models) return null;
        this.db.query("INSERT INTO reference_prices VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at").run(JSON.stringify(data.openai.models), this.now());
        return data.openai.models;
      } catch { return null; }
      finally { this.pending = undefined; }
    })();
    return this.pending;
  }
  async estimate(usage: ArticleUsage): Promise<ArticleUsage> {
    if (usage.provider !== "codex" || usage.costUsd != null || usage.tokensKnown === false) return usage;
    const models = await this.prices();
    const row = models?.[usage.model] as { cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }; limit?: { context?: number } } | undefined;
    const price = row?.cost;
    // Zero reference rates often mean an unpublished price. Unknown is never displayed as free.
    if (!price || typeof price.input !== "number" || !Number.isFinite(price.input) || price.input <= 0 || typeof price.output !== "number" || !Number.isFinite(price.output) || price.output <= 0) return usage;
    const cached = usage.cachedInputTokens ?? 0;
    const written = usage.cacheWriteInputTokens ?? 0;
    if (cached && (typeof price.cache_read !== "number" || !Number.isFinite(price.cache_read) || price.cache_read < 0)) return usage;
    if (written && (typeof price.cache_write !== "number" || !Number.isFinite(price.cache_write) || price.cache_write < 0)) return usage;
    // Reference base prices cannot establish tiered long-context pricing.
    if (usage.inputTokens > 200_000) return usage;
    const costUsd = ((usage.inputTokens - cached - written) * price.input + cached * (price.cache_read ?? 0) + written * (price.cache_write ?? 0) + usage.outputTokens * price.output) / 1_000_000;
    if (!Number.isFinite(costUsd) || costUsd < 0) return usage;
    return { ...usage, costUsd, costKind: "equivalent", costSource: SOURCE };
  }
}
