import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { systemClock } from "../src/server/clock";
import { createFakes } from "../src/server/fakes";
import { createHealthCheck, type HealthProbes } from "../src/server/health";

const allGood: HealthProbes = { hasExecutable: () => true, hasFile: () => true, copilotAuthenticated: async () => true };
const env = { RECAST_SMTP_USER: "a@b.c", RECAST_SMTP_PASSWORD: "x" };
const options = { ytDlp: "yt-dlp", ffmpeg: "ffmpeg", whisperCli: "whisper-cli", whisperModel: "/m.bin" };

async function health(probes: Partial<HealthProbes>, e: Record<string, string | undefined> = env) {
  const dataDir = mkdtempSync(join(tmpdir(), "recast-health-"));
  const app = createApp({
    dataDir,
    clock: systemClock,
    deps: createFakes(systemClock).deps,
    health: createHealthCheck({ ...allGood, ...probes }, { ...options, env: e }),
  });
  const res = await app.fetch(new Request("http://x/api/health"));
  app.stop();
  return (await res.json()) as { ok: boolean; problems: { key: string; message: string }[] };
}

test("reports ok when every dependency is present", async () => {
  expect(await health({})).toEqual({ ok: true, problems: [] });
});

test("names each missing dependency in Portuguese", async () => {
  const body = await health(
    { hasExecutable: () => false, hasFile: () => false, copilotAuthenticated: async () => false },
    {},
  );
  expect(body.ok).toBe(false);
  expect(body.problems.map((p) => p.key)).toEqual(["downloader", "converter", "transcriber", "model", "copilot", "email"]);
  expect(body.problems[0]!.message).toContain("yt-dlp");
});

test("only the missing one is reported", async () => {
  const body = await health({ hasExecutable: (bin) => bin !== "ffmpeg" });
  expect(body.problems.map((p) => p.key)).toEqual(["converter"]);
});

test("a half-set e-mail credential is reported", async () => {
  const body = await health({}, { RECAST_SMTP_USER: "a@b.c" });
  expect(body.problems.map((p) => p.key)).toEqual(["email"]);
});

test("a failing Copilot probe counts as not authenticated", async () => {
  const body = await health({ copilotAuthenticated: async () => { throw new Error("boom"); } });
  expect(body.problems.map((p) => p.key)).toEqual(["copilot"]);
});
