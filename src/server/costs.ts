import type { Database } from "bun:sqlite";
import type { GenerationProvider } from "./generation";

export interface CostTotals {
  inputTokens: number;
  outputTokens: number;
  credits: number;
  generations: number;
  /** Sum of known estimates; null when none of the generations has a known cost. */
  costUsd: number | null;
  unknownCosts: number;
  unknownUsage: number;
}
export interface Costs {
  total: CostTotals;
  byDay: ({ day: string } & CostTotals)[];
  byMonth: ({ month: string } & CostTotals)[];
  byChannel: ({ channelId: number | null; name: string | null } & CostTotals)[];
  byProvider: ({ provider: GenerationProvider } & CostTotals)[];
  byModel: ({ provider: GenerationProvider; model: string } & CostTotals)[];
}
const totals = (): CostTotals => ({ inputTokens: 0, outputTokens: 0, credits: 0, generations: 0, costUsd: 0, unknownCosts: 0, unknownUsage: 0 });
const localDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** Immutable records keep their original estimates. Legacy usage is Copilot credit-equivalent. */
export function costs(db: Database): Costs {
  const records = db.query<{ at: number; provider: GenerationProvider; model: string; inputTokens: number; outputTokens: number; credits: number; costUsd: number | null; tokensKnown: boolean; channelId: number | null; name: string | null }, []>(
    `SELECT u.created_at AS at, u.provider, u.model, u.input_tokens AS inputTokens, u.output_tokens AS outputTokens,
      u.credits, u.tokens_known AS tokensKnown, coalesce(u.cost_usd, CASE WHEN u.provider = 'copilot' AND u.credits_known THEN u.credits * 0.01 END) AS costUsd,
      v.channel_id AS channelId, v.channel_name AS name FROM usage_records u JOIN videos v ON v.id = u.video_id ORDER BY u.id`,
  ).all();
  const total = totals();
  const days = new Map<string, { day: string } & CostTotals>();
  const months = new Map<string, { month: string } & CostTotals>();
  const channels = new Map<number | null, { channelId: number | null; name: string | null } & CostTotals>();
  const providers = new Map<GenerationProvider, { provider: GenerationProvider } & CostTotals>();
  const models = new Map<string, { provider: GenerationProvider; model: string } & CostTotals>();
  const group = <K, T extends CostTotals>(map: Map<K, T>, key: K, init: () => T): T => { if (!map.has(key)) map.set(key, init()); return map.get(key)!; };
  for (const r of records) {
    const day = localDay(r.at), month = day.slice(0, 7);
    const groups = [total,
      group(days, day, () => ({ day, ...totals() })),
      group(months, month, () => ({ month, ...totals() })),
      group(channels, r.channelId, () => ({ channelId: r.channelId, name: r.channelId === null ? null : r.name, ...totals() })),
      group(providers, r.provider, () => ({ provider: r.provider, ...totals() })),
      group(models, `${r.provider}/${r.model}`, () => ({ provider: r.provider, model: r.model, ...totals() })),
    ];
    for (const g of groups) {
      g.generations++;
      g.inputTokens += r.inputTokens;
      g.outputTokens += r.outputTokens;
      if (r.provider === "copilot") g.credits += r.credits;
      if (r.costUsd !== null) g.costUsd! += r.costUsd;
      else g.unknownCosts++;
      if (!r.tokensKnown) g.unknownUsage++;
    }
  }
  const finish = <T extends CostTotals>(row: T): T => ({ ...row, costUsd: row.generations && row.unknownCosts === row.generations ? null : row.costUsd });
  const ranked = <T extends CostTotals>(rows: T[]) => rows.map(finish).sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1));
  return { total: finish(total), byDay: [...days.values()].map(finish).sort((a, b) => a.day.localeCompare(b.day)), byMonth: [...months.values()].map(finish).sort((a, b) => a.month.localeCompare(b.month)), byChannel: ranked([...channels.values()]), byProvider: ranked([...providers.values()]), byModel: ranked([...models.values()]) };
}
