/**
 * The UI over invented data and fake dependencies: nothing is downloaded, no model is called, no e-mail leaves.
 * For working on the interface: `bun run demo` (port 4281, or RECAST_DEMO_PORT). Every start begins from scratch.
 */
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { systemClock } from "../src/server/clock";
import type { GenerationAdapters } from "../src/server/providers";
import { GENERATION_PROVIDERS } from "../src/server/generation";
import { createFakes } from "../src/server/fakes";
import index from "../src/web/index.html";

const dataDir = mkdtempSync(join(tmpdir(), "recast-demo-"));
const port = Number(process.env.RECAST_DEMO_PORT ?? 4281);
const fakes = createFakes(systemClock, { tickMs: 4000 });

const FILLER = "The reasoning here is longer than it looks at first. I go back to the previous example, change one variable at a time, and show that the result only holds when all three conditions appear together. Take any one of them away and the difference disappears within the margin of error, which is why I insist on repeating the measurement before drawing conclusions.";

const ARTICLE = (topic: string, extra = 0) => `## TL;DR
- ${topic}: the core idea fits in one sentence, and the video spends its first minutes showing why it is not obvious.
- The measured gain was **38%** in the main scenario, but it drops close to zero when the load is small.
- Adopting it now is cheap; postponing gets more expensive with every release, because the old APIs go away in **March**.
- If you only need the result, skip straight to the practical part.

## Where the problem comes from [00:42]
The starting point is a simple observation: most of the time is not spent where you would expect. I show three measurements taken on the same project and, in all of them, the bottleneck was in the step nobody had looked at.

That changes the question. Instead of "how do we make this faster", it becomes "what are we waiting on".

## What we measured [04:15]
There were three scenarios, from smallest to largest:

1. A small project with few dependencies.
2. A medium project, similar to a product team's.
3. A monorepo with hundreds of packages.

Only in the third does the difference show up clearly: **38%** less waiting, on the same hardware.

> If you haven't measured, you don't know. And if you measured only once, you think you know.

## Where the approach falls short [11:30]
Not everything improves. On small loads the fixed startup cost eats the gain, and in two cases the result was worse than the original. I'm upfront about it and suggest a practical threshold: below **200 files**, the switch isn't worth it.

${Array.from({ length: extra }, () => FILLER).join("\n\n")}

## How to adopt it without stopping the team [17:08]
The migration has two steps. First, turn on compatibility mode, which keeps the old behavior and only logs what would change. After a week without warnings, flip the switch for good.

The \`migrate --dry-run\` command lists what would change without touching anything.

## Key takeaways
- Measure before changing anything; the bottleneck is rarely the obvious suspect.
- Below 200 files, stay where you are.
- Turn on compatibility mode today: it is reversible and shows how much work there is.
`;

const CHANNELS = [
  { channelId: "UCsBjURrPoezykLs9EqgamOA", name: "Fireship", handle: "@Fireship" },
  { channelId: "UCbRP3c757lWg9M-U7TyEkXA", name: "Theo - t3․gg", handle: "@t3dotgg" },
  { channelId: "UCYO_jab_esuFRV4b17AJtAw", name: "3Blue1Brown", handle: "@3blue1brown" },
  { channelId: "UCXUPKJO5MZQN11PqgIvyuvQ", name: "Andrej Karpathy", handle: "@AndrejKarpathy" },
  { channelId: "UC8butISFwT-Wl7EV0hUK0BQ", name: "freeCodeCamp.org", handle: "@freecodecamp" },
];
// [youtube id, title, channel index (-1 = ad hoc), minutes]
const VIDEOS: [string, string, number, number][] = [
  ["x7X9w_GIm1s", "Python in 100 Seconds", 0, 2], ["Tn6-PIqc4UM", "React in 100 Seconds", 0, 2], ["DHjqpvDnNGE", "JavaScript in 100 Seconds", 0, 3],
  ["zjkBMFhNj_g", "Intro to Large Language Models", 3, 60], ["kCc8FmEb1nY", "Let's build GPT: from scratch, in code, spelled out", 3, 116],
  ["VMj-3S1tku0", "The spelled-out intro to neural networks and backpropagation", 3, 145], ["l8pRSuU81PU", "Let's reproduce GPT-2 (124M)", 3, 241],
  ["7xTGNNLPyMI", "Deep Dive into LLMs like ChatGPT", 3, 211], ["LCEmiRjPEtQ", "Software Is Changing (Again)", -1, 39],
  ["aircAruvnKk", "But what is a neural network?", 2, 19], ["WUvTyaaNkzM", "The essence of calculus", 2, 17], ["fNk_zzaMoSs", "Vectors | Essence of linear algebra", 2, 10],
  ["IHZwWFHWa-w", "Gradient descent, how neural networks learn", 2, 21], ["Ilg3gGewQ5U", "Backpropagation, intuitively", 2, 13], ["wjZofJX0v4M", "Transformers, the tech behind LLMs", 2, 27],
  ["eMlx5fFNoYc", "Attention in transformers, step-by-step", 2, 26], ["spUNpyF58BY", "But what is the Fourier Transform?", 2, 21],
  ["8aGhZQkoFbQ", "What the heck is the event loop anyway?", -1, 27], ["cCOL7MC4Pl0", "In The Loop", -1, 35],
  ["rfscVS0vtbw", "Learn Python - Full Course for Beginners", 4, 266], ["PkZNo7MFNFg", "Learn JavaScript - Full Course for Beginners", 4, 206],
  ["Ke90Tje7VS0", "React JS - React Tutorial for Beginners", -1, 145], ["w7ejDZ8SWv8", "React JS Crash Course", -1, 108],
  ["SqcY0GlETPk", "React Tutorial for Beginners", -1, 80], ["8jLOx1hD3_o", "Harvard CS50 – Full Computer Science University Course", 4, 1500],
  ["ZXsQAXx_ao0", "I tried the new compiler so you don't have to", 1, 24], ["hQAHSlTtcmY", "The end of bundlers?", 1, 31], ["lsMQRaeKNDk", "Why I stopped using ORMs", 1, 18],
  ["Sklc_fQBmcs", "Next.js is getting faster", 1, 22], ["UBOj6rqRUME", "Bun is eating Node's lunch", 0, 6], ["rZ41y93P2Qo", "10 CSS tricks you didn't know", 0, 9],
  ["ky5ZB-mqZKM", "Rust for the impatient", 0, 11], ["5C_HPTJg5ek", "Rust in 100 Seconds", 0, 2], ["lHhRhPV--G0", "Flutter in 100 Seconds", 0, 2],
  ["zQnBQ4tB3ZA", "TypeScript in 100 Seconds", 0, 2], ["lkIFF4maKMU", "100+ JavaScript Concepts you Need to Know", 0, 12], ["q1fsBWLpYW4", "Vim in 100 Seconds", 0, 2],
  ["rf60MejMz3E", "Recursion in 100 Seconds", 0, 2], ["-MTSQjw5DrM", "RESTful APIs in 100 Seconds", 0, 11], ["Rs_rAxEsAvI", "Docker in 100 Seconds", 0, 2],
];
const LIVE: [string, string, string, number][] = [
  ["PziYflu8cB8", "Kubernetes Explained in 100 Seconds", "Fireship", 2], ["HyWYpM_S-2c", "How I'd learn to code in 2026", "Theo - t3․gg", 28],
  ["r6sGWTCMz2k", "But what is a convolution?", "3Blue1Brown", 23], ["XfpMkf4rD6E", "State of GPT", "Andrej Karpathy", 42],
];

for (const c of CHANNELS) fakes.addChannel({ ...c, imageUrl: null });
for (const [id, title, channel, minutes] of LIVE) fakes.publish(id, { title, channel, duration: minutes * 60, timestamp: Math.floor(Date.now() / 1000) - 7200 });
fakes.deps.writer.write = async (input, ctx) => {
  const text = ARTICLE(input.video.title ?? "The video");
  const pieces = text.match(/[\s\S]{1,48}/g)!;
  let markdown = "";
  for (const [i, piece] of pieces.entries()) {
    await systemClock.sleep(350);
    if (ctx.signal.aborted) throw new Error("cancelled");
    markdown += piece;
    ctx.onText(piece);
    ctx.onProgress({ percent: Math.round(((i + 1) / pieces.length) * 100) });
  }
  return { markdown, usage: { provider: input.provider, model: input.model, inputTokens: 9000, outputTokens: 1800, credits: input.provider === "copilot" ? 0.19 : null, costUsd: 0.0019, costKind: "estimated" as const, costSource: "Demo" } };
};

// Explicit demo fixtures: production catalogs always use remote provider discovery.
const demoModels = { copilot: "gpt-6-luna", claude: "claude-demo", codex: "codex-demo" };
const generation = Object.fromEntries(GENERATION_PROVIDERS.map((provider) => [provider, {
  writer: fakes.deps.writer,
  probe: async () => ({ state: provider === "claude" ? "unconfigured" : "authenticated", authMethod: "Demo", detail: "Simulated data; no real authentication was checked." }),
  models: async () => ({ models: [{ id: demoModels[provider], name: `Demo ${provider}` }], updatedAt: Date.now() }),
}])) as GenerationAdapters;
const app = createApp({ dataDir, clock: systemClock, deps: fakes.deps, generation, baseUrl: `http://localhost:${port}` });
const db = new Database(join(dataDir, "recast.db"));
let seed = 7;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
const now = Date.now();
const DAY = 86_400_000;

db.run("INSERT INTO settings (key, value) VALUES ('recipient', 'you@example.com')");
CHANNELS.forEach((c, i) =>
  db.query("INSERT INTO channels (youtube_id, name, handle, status, active_since, last_checked_at, next_check_at, last_error, created_at, instructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    c.channelId, c.name, c.handle, i === 4 ? "paused" : "active", now - 50 * DAY, now - (3 + i * 2) * 60_000, now + (12 - i * 2) * 60_000,
    i === 1 ? "Could not look up video hQAHSlTtcmY: HTTP Error 429: Too Many Requests" : null, now - 50 * DAY,
    i === 2 ? "Explain the geometric intuition before the formulas. Describe in words what the animations show." : null,
  ),
);
const run = (video: number, stage: string, attempt: number, status: string, start: number, ms: number, error: string | null = null) =>
  db.query("INSERT INTO stage_runs (video_id, stage, attempt, status, percent, queued_at, started_at, finished_at, error, log, output) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '')").run(
    video, stage, attempt, status, status === "done" ? 100 : 37, start - 1500, start, start + ms, error, `${stage}: tentativa ${attempt}\n${error ?? "ok"}\n`,
  );
VIDEOS.forEach(([youtubeId, title, channel, minutes], i) => {
  // Older first; activity grows towards today, with a few quiet days.
  const at = now - Math.round((45 * (1 - i / VIDEOS.length) ** 1.4 + rand() * 0.8) * DAY) - 3 * 3_600_000;
  const state = i === 24 ? "failed" : i === 17 ? "cancelled" : "completed";
  const seconds = minutes * 60 + Math.floor(rand() * 50);
  const id = Number(
    db.query("INSERT INTO videos (youtube_id, url, state, created_at, title, channel_name, duration_seconds, channel_id, origin, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      youtubeId, `https://www.youtube.com/watch?v=${youtubeId}`, state, at, title, channel < 0 ? ["JSConf", "Andrej Karpathy", "Programming with Mosh"][i % 3]! : CHANNELS[channel]!.name,
      seconds, channel < 0 ? null : channel + 1, channel < 0 ? "ad_hoc" : "channel", at - Math.round(rand() * 5 * 3_600_000),
    ).lastInsertRowid,
  );
  let t = at;
  const stage = (name: string, ms: number, fails = 0) => {
    for (let a = 1; a <= fails; a++) {
      run(id, name, a, "failed", t, ms / 3, name === "download" ? "HTTP Error 429: Too Many Requests" : "Copilot took too long to write the article.");
      t += ms / 3 + 30_000 * a;
    }
    run(id, name, fails + 1, "done", t, ms);
    t += ms + 1500;
  };
  stage("download", 6000 + seconds * 4 + rand() * 9000, i % 9 === 4 ? 1 : 0);
  if (state === "cancelled") return void run(id, "transcription", 1, "cancelled", t, 40_000);
  stage("transcription", seconds * 1000 * (0.05 + rand() * 0.03));
  db.query("INSERT INTO transcripts (video_id, language, segments) VALUES (?, 'en', ?)").run(
    id, JSON.stringify(Array.from({ length: 40 }, (_, n) => ({ startMs: n * 9000, endMs: n * 9000 + 8000, text: "So the thing I want to show here is that the measurement changes once you stop looking at the obvious place." }))),
  );
  if (state === "failed") {
    for (let a = 1; a <= 3; a++) run(id, "article", a, "failed", t + a * 60_000, 900, "The transcript does not fit the selected model's context window (estimated before sending).");
    return;
  }
  const model = i % 7 === 3 ? "claude-sonnet-5.5" : i % 5 === 2 ? "gpt-5.4-mini" : "gpt-6-luna";
  stage("article", 18_000 + seconds * 9 + rand() * 12_000, i % 11 === 6 ? 2 : 0);
  const input = Math.round(seconds * 4.6 + 900);
  const usage = Number(
    db.query("INSERT INTO usage_records (video_id, model, input_tokens, output_tokens, credits, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id, model, input, 1400 + Math.round(rand() * 900), (input / 1e6) * (model === "claude-sonnet-5.5" ? 38 : model === "gpt-5.4-mini" ? 6 : 19) + 0.03, t,
    ).lastInsertRowid,
  );
  db.query("INSERT INTO articles (video_id, markdown, complete, usage_record_id) VALUES (?, ?, 1, ?)").run(id, ARTICLE(title, Math.min(40, Math.round(minutes / 2.2))), usage);
  stage("delivery", 1800 + rand() * 2500);
});
[["Shorts: this one trick", 0, "short", "This is a Short; Recast only processes ordinary videos."], ["Live coding the new router", 1, "live", "This is a livestream (ongoing or completed); Recast only processes ordinary videos."],
 ["Q&A for members", 2, "members", "This video is exclusive to channel members."], ["30 seconds of CSS", 0, "short", "This is a Short; Recast only processes ordinary videos."],
 ["Office hours", 1, "live", "This is a livestream (ongoing or completed); Recast only processes ordinary videos."], ["Tiny tip #41", 0, "short", "This is a Short; Recast only processes ordinary videos."],
].forEach(([title, channel, why, reason], i) =>
  db.query("INSERT INTO ignored_publications (youtube_id, channel_id, channel_name, title, published_at, why, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
    `ignored${i}aaaa`, (channel as number) + 1, CHANNELS[channel as number]!.name, title, now - (i * 4 + 1) * DAY, why, reason, now - (i * 4 + 1) * DAY,
  ),
);
db.close();

app.start();
const request = (id: string) =>
  app.fetch(new Request("http://demo/api/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `https://www.youtube.com/watch?v=${id}` }) }));
for (const [id] of LIVE) await request(id);

const server = Bun.serve({ hostname: "0.0.0.0", port, idleTimeout: 0, routes: { "/": index, "/api/*": (req) => app.fetch(req) } });
console.log(`Recast (demo) at http://${server.hostname}:${server.port} (temporary data in ${dataDir})`);
