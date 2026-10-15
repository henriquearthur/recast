import { describe, expect, test } from "bun:test";
import type { ListedPublication, ResolvedChannel } from "../src/server/deps";
import { createTestApp } from "./harness";

const MIN = 60_000;
const GOOGLE: ResolvedChannel = { channelId: "UC_google", name: "Google Devs", handle: "@GoogleDevelopers", imageUrl: null };
const id = (n: number) => `vid${String(n).padStart(8, "0")}`;
const withLanguage = (global: string) => `${global.trim()}\n\nWrite the article in English (en), whatever the language of the transcript.`;
const listed = (n: number, publishedAt: number): ListedPublication => ({ youtubeId: id(n), title: `Video ${n}`, publishedAt, isShort: false });

function setup() {
  const t = createTestApp();
  t.fakes.addChannel(GOOGLE);
  return t;
}
const setInstructions = (t: ReturnType<typeof setup>, channelId: number, instructions: string) =>
  t.request(`/api/channels/${channelId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instructions }),
  });
async function addChannel(t: ReturnType<typeof setup>) {
  return (await (await t.api.addChannel("@GoogleDevelopers")).json()) as { id: number };
}
/** Publishes video `n` on the Channel and lets the pipeline run to the end. */
async function detectVideo(t: ReturnType<typeof setup>, n: number) {
  t.fakes.publish(id(n), { title: `Video ${n}`, channel: "Google Devs", duration: 600 });
  t.fakes.setFeed("UC_google", [listed(n, t.clock.now() + MIN)]);
  await t.clock.advance(15 * MIN + 60_000);
  return (await t.api.listVideos()).find((v) => v.youtubeId === id(n))!;
}

describe("Channel Instructions", () => {
  test("are editable on the Channel and shown in its view", async () => {
    const t = setup();
    const channel = await addChannel(t);
    expect((await t.api.listChannels())[0]!.instructions).toBeNull();
    const res = await setInstructions(t, channel.id, "Focus on code examples.");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: channel.id, instructions: "Focus on code examples." });
    expect((await t.api.listChannels())[0]!.instructions).toBe("Focus on code examples.");
    expect((await setInstructions(t, 999, "x")).status).toBe(404);
  });

  test("a detected Video is written with the Global Prompt plus the Channel Instructions", async () => {
    const t = setup();
    const channel = await addChannel(t);
    await setInstructions(t, channel.id, "Focus on code examples.");
    const global = (await t.api.getSettings()).globalPrompt!;
    await detectVideo(t, 1);
    const sent = t.fakes.writes[0]!.instructions;
    expect(sent.startsWith(global.trim())).toBe(true);
    expect(sent).toContain("Focus on code examples.");
    expect(sent.length).toBeGreaterThan(global.trim().length);
  });

  test("a Channel without instructions, or blank ones, uses the Global Prompt and the Article language alone", async () => {
    const t = setup();
    const channel = await addChannel(t);
    const global = (await t.api.getSettings()).globalPrompt!;
    await detectVideo(t, 1);
    await setInstructions(t, channel.id, "   ");
    expect((await t.api.listChannels())[0]!.instructions).toBeNull();
    await detectVideo(t, 2);
    expect(t.fakes.writes.map((w) => w.instructions)).toEqual([withLanguage(global), withLanguage(global)]);
  });

  test("an ad hoc Video uses the Global Prompt and the Article language alone, even when a Channel has instructions", async () => {
    const t = setup();
    const channel = await addChannel(t);
    await setInstructions(t, channel.id, "Focus on code examples.");
    const global = (await t.api.getSettings()).globalPrompt!;
    await t.api.requestVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa");
    await t.clock.advance(60_000);
    expect(t.fakes.writes.map((w) => w.instructions)).toEqual([withLanguage(global)]);
  });

  test("a regeneration uses the instructions as they are now", async () => {
    const t = setup();
    const channel = await addChannel(t);
    const video = await detectVideo(t, 1);
    await setInstructions(t, channel.id, "Summarize in bullet points.");
    await t.request(`/api/videos/${video.id}/regenerate`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await t.clock.advance(60_000);
    expect(t.fakes.writes[0]!.instructions).not.toContain("Summarize in bullet points.");
    expect(t.fakes.writes[1]!.instructions).toContain("Summarize in bullet points.");
  });
});
