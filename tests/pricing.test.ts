import { expect, test } from "bun:test";
import { openDatabase } from "../src/server/db";
import { CodexPricing } from "../src/server/pricing";
import { costs } from "../src/server/costs";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const db = () => openDatabase(mkdtempSync(join("/tmp", "recast-prices-")));
test("Codex reference estimate includes cached tokens and preserves missing prices as unknown", async () => {
  const store = db(); let requests = 0;
  const pricing = new CodexPricing(store, (async () => { requests++; return Response.json({ openai: { models: { remote: { cost: { input: 2, output: 8, cache_read: 0.5 } }, unpublished: { cost: { input: 0, output: 0 } } } } }); }) as unknown as typeof fetch, () => 100);
  const usage = { provider: "codex" as const, model: "remote", inputTokens: 1000, cachedInputTokens: 400, outputTokens: 100, credits: null };
  expect(await pricing.estimate(usage)).toMatchObject({ costUsd: 0.0022, costKind: "equivalent", costSource: "https://models.dev/api.json" });
  expect((await pricing.estimate({ ...usage, model: "unpublished" })).costUsd).toBeUndefined();
  expect((await pricing.estimate({ ...usage, inputTokens: 300_000 })).costUsd).toBeUndefined();
  expect(requests).toBe(1);
  store.close();
});
test("cost totals remain partial and group identical model names by provider", () => {
  const store = db();
  store.run("INSERT INTO videos (youtube_id,url,state,created_at) VALUES ('aaaaaaaaaaa','test','completed',0)");
  store.run("INSERT INTO usage_records (video_id,model,input_tokens,output_tokens,credits,created_at) VALUES (1,'same',10,2,2,0)");
  store.run("INSERT INTO usage_records (video_id,model,input_tokens,output_tokens,credits,created_at,provider,credits_known,tokens_known) VALUES (1,'same',0,0,0,0,'codex',0,0)");
  const report = costs(store);
  expect(report.total).toMatchObject({ costUsd: 0.02, unknownCosts: 1, unknownUsage: 1, credits: 2, generations: 2 });
  expect(report.byModel).toHaveLength(2);
  expect(report.byModel.find((g) => g.provider === "codex")?.costUsd).toBeNull();
  expect(() => store.run("UPDATE usage_records SET cost_usd = 0")).toThrow("immutable");
  store.close();
});
