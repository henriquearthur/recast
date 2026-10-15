import { describe, expect, test } from "bun:test";
import { openDatabase } from "../src/server/db";
import { GENERATION_PROVIDERS, type GenerationProvider } from "../src/server/generation";
import { Providers, type GenerationAdapters } from "../src/server/providers";
import { createTestApp } from "./harness";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

const generation: NonNullable<Parameters<typeof createTestApp>[1]>["generation"] = (fakes, clock) => Object.fromEntries(GENERATION_PROVIDERS.map((provider) => [provider, {
  writer: fakes.deps.writer,
  probe: async () => ({ state: provider === "codex" ? "unconfigured" : "authenticated", authMethod: provider === "claude" ? "API key" : "host", detail: null }),
  models: async () => ({ models: [{ id: `${provider}-online`, name: `${provider} model` }], updatedAt: clock.now() }),
}])) as unknown as GenerationAdapters;
const url = "https://www.youtube.com/watch?v=aaaaaaaaaaa";

describe("generation provider selection", () => {
  test("selection takes effect at Article start and remains frozen through automatic retries", async () => {
    const t = createTestApp(undefined, { generation });
    const { id } = await (await t.api.requestVideo(url)).json();
    await t.clock.advance(5000); // transcribing
    await t.api.putSetting("claudeModel", "claude-online");
    await t.api.putSetting("provider", "claude");
    t.fakes.fail("article", 1, "temporary", { consumed: true });
    await t.clock.advance(7000); // first Article attempt has failed
    await t.api.putSetting("provider", "copilot");
    await t.api.putSetting("copilotModel", "copilot-online");
    await t.clock.advance(90_000);
    expect(t.fakes.writes.map((w) => [w.provider, w.model])).toEqual([["claude", "claude-online"], ["claude", "claude-online"]]);
    expect((await t.api.getVideo(id)).article?.usage).toMatchObject({ provider: "claude", model: "claude-online" });
    await t.request(`/api/videos/${id}/regenerate`, { method: "POST", body: "{}" });
    await t.clock.advance(60_000);
    expect(t.fakes.writes.at(-1)).toMatchObject({ provider: "copilot", model: "copilot-online" });
    expect((await t.api.getCosts()).byProvider.map((g) => g.provider).sort()).toEqual(["claude", "copilot"]);
    t.app.stop();
  });
  test("unselected unavailable providers do not affect health; selected ones do", async () => {
    const t = createTestApp(undefined, { generation });
    expect(await (await t.request("/api/health")).json()).toMatchObject({ ok: true });
    expect((await t.api.putSetting("provider", "codex")).status).toBe(200);
    expect(await (await t.request("/api/health")).json()).toMatchObject({ ok: false, problems: [{ key: "generation" }, { key: "generation" }] });
    const providers = await (await t.request("/api/providers")).json();
    expect(providers).toHaveLength(3);
    expect(providers.every((p: { lastGeneration: unknown }) => p.lastGeneration === null)).toBe(true);
    expect(t.fakes.writes).toHaveLength(0);
    t.app.stop();
  });
  test("settings accept only discovered model identifiers, atomically, and reject per-video overrides", async () => {
    const t = createTestApp(undefined, { generation });
    expect((await t.api.putSetting("claudeModel", "invented")).status).toBe(400);
    const response = await t.request("/api/settings", { method: "PUT", body: JSON.stringify({ recipient: "changed@example.com", claudeModel: "invented" }) });
    expect(response.status).toBe(400);
    expect((await t.api.getSettings()).recipient).toBe("me@example.com");
    expect((await t.api.putSetting("provider", "invented")).status).toBe(400);
    expect((await t.request("/api/videos/1/regenerate", { method: "POST", body: JSON.stringify({ model: "invented" }) })).status).toBe(400);
    await t.api.putSetting("claudeModel", "claude-online");
    await t.api.putSetting("provider", "claude");
    await t.api.putSetting("copilotModel", "copilot-online");
    expect(await t.api.getSettings()).toMatchObject({ claudeModel: "claude-online", copilotModel: "copilot-online" });
    t.app.stop();
  });
});

test("remote catalog survives failures and restarts; failed first fetch has no invented fallback", async () => {
  const db = openDatabase(mkdtempSync(join("/tmp", "recast-catalog-")));
  let calls = 0, offline = false;
  const adapters = Object.fromEntries(GENERATION_PROVIDERS.map((provider) => [provider, {
    writer: { write: async () => { throw new Error("must not generate"); } },
    probe: async () => ({ state: "authenticated", authMethod: "test", detail: null }),
    models: async () => { calls++; if (offline) throw new Error("offline"); return { models: [{ id: `${provider}-remote`, name: "Remote" }], updatedAt: 100 }; },
  }])) as unknown as GenerationAdapters;
  const providers = new Providers(db, adapters, () => 100);
  await Promise.all([providers.catalog("copilot"), providers.catalog("copilot")]);
  expect(calls).toBe(1);
  offline = true;
  const failed = await providers.catalog("copilot", true);
  expect(failed).toMatchObject({ updatedAt: 100, error: "offline", models: [{ id: "copilot-remote" }] });
  const restarted = new Providers(db, adapters, () => 200);
  expect(await restarted.catalog("copilot")).toMatchObject({ updatedAt: 100, models: [{ id: "copilot-remote" }] });
  expect(await restarted.catalog("claude")).toEqual({ updatedAt: null, models: [], error: "offline" });
  db.close();
});

test("manual retries and restart recovery keep the provider captured by the Article", async () => {
  const t = createTestApp(undefined, { generation });
  await t.api.putSetting("provider", "claude");
  await t.api.putSetting("claudeModel", "claude-online");
  t.fakes.fail("article", 3, "temporary");
  const { id } = await (await t.api.requestVideo(url)).json();
  await t.clock.advance(200_000);
  expect((await t.api.getVideo(id)).state).toBe("failed");
  await t.api.putSetting("provider", "copilot");
  await t.api.putSetting("copilotModel", "copilot-online");
  await t.request(`/api/videos/${id}/retry`, { method: "POST", body: "{}" });
  await t.clock.advance(1000);
  expect(t.fakes.writes.at(-1)).toMatchObject({ provider: "claude", model: "claude-online" });
  t.app.stop();
  const restarted = createTestApp(t.dataDir, { generation });
  await restarted.clock.advance(60_000);
  expect(restarted.fakes.writes.at(-1)).toMatchObject({ provider: "claude", model: "claude-online" });
  expect((await restarted.api.getVideo(id)).article?.usage).toMatchObject({ provider: "claude", model: "claude-online" });
  restarted.app.stop();
});
