import type { GenerationAdapters } from "../src/server/providers";
import type { ArticleUsage } from "../src/server/deps";
import type { Costs } from "../src/server/costs";
export type { Costs } from "../src/server/costs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import type { Clock } from "../src/server/clock";
import { createFakes, type Fakes } from "../src/server/fakes";

/** Clock that only moves when the test calls `advance`. */
export function createManualClock(start = 1_700_000_000_000) {
  let current = start;
  let timers: { at: number; resolve: () => void }[] = [];
  const settle = () => new Promise<void>((r) => setImmediate(r));
  const clock: Clock & { advance(ms: number): Promise<void> } = {
    now: () => current,
    sleep(ms) {
      return new Promise<void>((resolve) => timers.push({ at: current + ms, resolve }));
    },
    async advance(ms) {
      const target = current + ms;
      await settle();
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        current = due.at;
        due.resolve();
        await settle();
      }
      current = target;
      await settle();
    },
  };
  return clock;
}

export type VideoView = {
  id: number;
  youtubeId: string;
  url: string;
  title: string | null;
  channelName: string | null;
  origin: "channel" | "ad_hoc";
  channelId: number | null;
  durationSeconds: number | null;
  state: "in_progress" | "completed" | "failed" | "cancelled";
  stages: {
    stage: string;
    status: "waiting" | "running" | "done" | "failed" | "cancelled";
    percent: number | null;
    detail: string | null;
    attempts: number;
    error: string | null;
    retryAt: number | null;
    queuePosition: number | null;
  }[];
  article: {
    markdown: string;
    complete: boolean;
    draft: string | null;
    usage: ArticleUsage | null;
  } | null;
};

type CostTotals = { inputTokens: number; outputTokens: number; credits: number; generations: number };
export type ChannelView = {
  id: number;
  youtubeChannelId: string;
  name: string;
  handle: string | null;
  imageUrl: string | null;
  status: "active" | "paused";
  activeSince: number;
  lastCheckedAt: number | null;
  nextCheckAt: number | null;
  lastError: string | null;
  instructions: string | null;
};

export type IgnoredPublication = {
  youtubeId: string;
  title: string | null;
  channelId: number;
  channelName: string;
  publishedAt: number;
  why: string;
  reason: string;
};


export type Attempt = {
  stage: string;
  attempt: number;
  status: string;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  log: string;
};

/** `recipient` is the delivery address already configured at startup; pass null to leave it unset. */
export function createTestApp(
  dataDir = mkdtempSync(join(tmpdir(), "recast-test-")),
  { recipient = "me@example.com", clockStart, beforeStart, generation, ...fakeOpts }: { recipient?: string | null; clockStart?: number; beforeStart?: (fakes: Fakes) => void; generation?: (fakes: Fakes, clock: Clock) => GenerationAdapters } & Parameters<typeof createFakes>[1] = {},
) {
  const clock = createManualClock(clockStart);
  const fakes: Fakes = createFakes(clock, fakeOpts);
  const app = createApp({ dataDir, clock, deps: fakes.deps, generation: generation?.(fakes, clock), baseUrl: "http://recast.test" });
  beforeStart?.(fakes);
  app.start();

  // The recipient is configured the way the user does it, through the API, before the first request goes through.
  const configured = recipient
    ? app.fetch(
        new Request("http://recast.test/api/settings/recipient", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ value: recipient }),
        }),
      )
    : Promise.resolve();
  const request = async (path: string, init?: RequestInit) => {
    await configured;
    return app.fetch(new Request(`http://recast.test${path}`, init));
  };
  const post = (path: string, body: unknown) =>
    request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const api = {
    async requestVideo(url: string) {
      return request("/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url }),
      });
    },
    async getVideo(id: number): Promise<VideoView> {
      return (await request(`/api/videos/${id}`)).json();
    },
    async command(id: number, action: "retry" | "cancel" | "resume") {
      return request(`/api/videos/${id}/${action}`, { method: "POST" });
    },
    async getAttempts(id: number): Promise<Attempt[]> {
      return (await request(`/api/videos/${id}/attempts`)).json();
    },
    async listVideos(): Promise<VideoView[]> {
      return (await request("/api/videos")).json();
    },
    async resolveChannel(input: string) {
      return post("/api/channels/resolve", { input });
    },
    async addChannel(input: string) {
      return post("/api/channels", { input });
    },
    async pauseChannel(id: number) {
      return post(`/api/channels/${id}/pause`, {});
    },
    async resumeChannel(id: number) {
      return post(`/api/channels/${id}/resume`, {});
    },
    async removeChannel(id: number) {
      return request(`/api/channels/${id}`, { method: "DELETE" });
    },
    async listChannels(): Promise<ChannelView[]> {
      return (await request("/api/channels")).json();
    },
    async listIgnored(query = ""): Promise<IgnoredPublication[]> {
      return (await request(`/api/ignored${query}`)).json();
    },
    async getCosts(): Promise<Costs> {
      return (await request("/api/costs")).json();
    },
    async getSettings(): Promise<Record<string, string>> {
      return (await request("/api/settings")).json();
    },
    async putSetting(key: string, value: string) {
      return request(`/api/settings/${key}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value }),
      });
    },
  };

  /** Opens the SSE stream and collects every `video` event received. */
  async function subscribe() {
    const res = await request("/api/events");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: VideoView[] = [];
    const channelEvents: ChannelView[] = [];
    const chunks: { id: number; offset: number; delta: string }[] = [];
    const logs: { videoId: number; stage: string; attempt: number; line: string }[] = [];
    let buffer = "";
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
        let i;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (chunk.includes("event: video") && data) events.push(JSON.parse(data.slice(6)));
          if (chunk.includes("event: article_chunk") && data) chunks.push(JSON.parse(data.slice(6)));
          if (chunk.includes("event: channel") && data) channelEvents.push(JSON.parse(data.slice(6)));
          if (chunk.includes("event: log") && data) logs.push(JSON.parse(data.slice(6)));
        }
      }
    })();
    return { res, events, channelEvents, chunks, logs, close: () => reader.cancel().then(() => pump) };
  }

  return { app, clock, fakes, api, request, subscribe, dataDir };
}
