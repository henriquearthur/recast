import type { Database } from "bun:sqlite";
import { ArticleWriteError } from "./deps";
import { CodexPricing } from "./pricing";
import type { ArticleWriter } from "./deps";
import { GENERATION_PROVIDERS, type GenerationModel, type GenerationProvider, type ModelCatalog, type ProviderStatus } from "./generation";

export interface GenerationAdapter {
  writer: ArticleWriter;
  /** Checks credentials/runtime without generating text. Never returns secrets. */
  probe(): Promise<Pick<ProviderStatus, "state" | "authMethod" | "detail">>;
  /** Only remote catalogs: a runtime's bundled fallback must never enter this result. */
  models(): Promise<{ models: GenerationModel[]; updatedAt: number }>;
}
export type GenerationAdapters = Record<GenerationProvider, GenerationAdapter>;
const CATALOG_TTL = 6 * 60 * 60_000;

export class Providers {
  private refreshing = new Map<GenerationProvider, Promise<ModelCatalog>>();
  private errors = new Map<GenerationProvider, string>();
  private probes = new Map<GenerationProvider, { at: number; promise: ReturnType<GenerationAdapter["probe"]> }>();
  private pricing: CodexPricing;
  constructor(private db: Database, private adapters: GenerationAdapters, private now = Date.now) { this.pricing = new CodexPricing(db, fetch, now); }

  readonly writer: ArticleWriter = {
    write: async (input, ctx) => {
      if (!input.model) throw new Error("No generation model selected: choose one in Settings.");
      const adapter = this.adapters[input.provider];
      if (!adapter) throw new Error("Invalid generation provider.");
      try {
        const metadata = this.saved(input.provider).models.find((m) => m.id === input.model);
        const result = await adapter.writer.write({ ...input, contextWindow: metadata?.contextWindow }, ctx);
        return { ...result, usage: await this.pricing.estimate({ ...result.usage, provider: input.provider }) };
      } catch (error) {
        if (error instanceof ArticleWriteError) throw new ArticleWriteError(error.original, await this.pricing.estimate({ ...error.usage, provider: input.provider }));
        throw error;
      }
    },
  };

  private saved(provider: GenerationProvider): ModelCatalog {
    const row = this.db.query<{ models: string; updated_at: number }, [string]>("SELECT models, updated_at FROM provider_catalogs WHERE provider = ?").get(provider);
    return { models: row ? JSON.parse(row.models) : [], updatedAt: row?.updated_at ?? null, error: this.errors.get(provider) ?? null };
  }

  async catalog(provider: GenerationProvider, refresh = false): Promise<ModelCatalog> {
    const saved = this.saved(provider);
    if (!refresh && saved.updatedAt !== null && this.now() - saved.updatedAt < CATALOG_TTL) return saved;
    const pending = this.refreshing.get(provider);
    if (pending) return pending;
    const work = (async () => {
      try {
        const remote = await this.adapters[provider].models();
        if (!remote.models.length || !Number.isFinite(remote.updatedAt)) throw new Error("No models available in the online catalog.");
        this.db.query("INSERT INTO provider_catalogs (provider, models, updated_at) VALUES (?, ?, ?) ON CONFLICT(provider) DO UPDATE SET models = excluded.models, updated_at = excluded.updated_at")
          .run(provider, JSON.stringify(remote.models), remote.updatedAt);
        this.errors.delete(provider);
        this.probes.delete(provider);
      } catch (error) {
        // Adapter diagnostics are sanitized; never persist responses that could contain credentials.
        this.errors.set(provider, error instanceof Error ? error.message : "Could not refresh models.");
      } finally {
        this.refreshing.delete(provider);
      }
      return this.saved(provider);
    })();
    this.refreshing.set(provider, work);
    return work;
  }

  async status(selected?: GenerationProvider): Promise<ProviderStatus[]> {
    return Promise.all((selected ? [selected] : GENERATION_PROVIDERS).map(async (provider) => {
      let cached = this.probes.get(provider);
      if (!cached || this.now() - cached.at >= 30_000) {
        cached = { at: this.now(), promise: this.adapters[provider].probe().catch(() => ({ state: "error" as const, authMethod: null, detail: "Could not verify the provider." })) };
        this.probes.set(provider, cached);
      }
      const probe = await cached.promise;
      const last = this.db.query<{ status: string; at: number; model: string; error: string | null }, [string]>(
        "SELECT status, finished_at AS at, model, error FROM stage_runs WHERE stage = 'article' AND coalesce(provider, 'copilot') = ? AND finished_at IS NOT NULL ORDER BY id DESC LIMIT 1",
      ).get(provider);
      return { provider, ...probe, checkedAt: cached.at, catalog: this.saved(provider), lastGeneration: last };
    }));
  }
}
