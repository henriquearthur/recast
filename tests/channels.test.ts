import { describe, expect, test } from "bun:test";
import { PublicationUnavailableError } from "../src/server/deps";
import type { ListedPublication, ResolvedChannel } from "../src/server/deps";
import { createTestApp } from "./harness";

const MIN = 60_000;
const GOOGLE: ResolvedChannel = { channelId: "UC_google", name: "Google Devs", handle: "@GoogleDevelopers", imageUrl: "https://img/g.jpg" };
const NASA: ResolvedChannel = { channelId: "UC_nasa", name: "NASA", handle: "@NASA", imageUrl: null };

const id = (n: number) => `vid${String(n).padStart(8, "0")}`;
const listed = (n: number, publishedAt: number, extra: Partial<ListedPublication> = {}): ListedPublication => ({
  youtubeId: id(n),
  title: `Video ${n}`,
  publishedAt,
  isShort: false,
  ...extra,
});

function setup() {
  const t = createTestApp();
  t.fakes.addChannel(GOOGLE);
  t.fakes.addChannel(NASA);
  return t;
}
async function add(t: ReturnType<typeof setup>, input = "@GoogleDevelopers") {
  const res = await t.api.addChannel(input);
  expect(res.status).toBe(201);
  return res.json();
}

describe("adding a Channel", () => {
  test("resolving by @handle or URL shows name and image before confirming, and adds nothing", async () => {
    const t = setup();
    for (const input of ["@GoogleDevelopers", "https://www.youtube.com/@GoogleDevelopers"]) {
      const res = await t.api.resolveChannel(input);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ name: "Google Devs", imageUrl: "https://img/g.jpg", alreadyAdded: false });
    }
    expect(await t.api.listChannels()).toEqual([]);
  });

  test("an unknown channel is reported as not found", async () => {
    const t = setup();
    expect((await t.api.resolveChannel("@nao-existe")).status).toBe(404);
    expect((await t.api.addChannel("@nao-existe")).status).toBe(404);
  });

  test("confirming creates an active Channel with its first check in 15 minutes", async () => {
    const t = setup();
    const now = t.clock.now();
    const channel = await add(t);
    expect(channel).toMatchObject({
      name: "Google Devs",
      status: "active",
      activeSince: now,
      lastCheckedAt: null,
      nextCheckAt: now + 15 * MIN,
      lastError: null,
    });
    expect(await t.api.listChannels()).toHaveLength(1);
  });

  test("adding a Channel that exists warns instead of duplicating", async () => {
    const t = setup();
    await add(t);
    const dup = await t.api.addChannel("https://www.youtube.com/@GoogleDevelopers");
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toContain("already been added");
    expect(await (await t.api.resolveChannel("@GoogleDevelopers")).json()).toMatchObject({ alreadyAdded: true });
    expect(await t.api.listChannels()).toHaveLength(1);
  });

  test("what the Channel already published is not processed", async () => {
    const t = setup();
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() - 60 * MIN), listed(2, t.clock.now() - 1)]);
    await add(t);
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toEqual([]);
    expect(t.fakes.lookups).toEqual([]);
    expect(await t.api.listIgnored()).toEqual([]);
  });
});

describe("detection", () => {
  test("a new Video enters the Download queue, tied to its Channel, at the next check", async () => {
    const t = setup();
    const sse = await t.subscribe();
    const channel = await add(t);
    t.fakes.publish(id(1), { title: "New lesson", channel: "Google Devs", duration: 600 });
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + 5 * MIN)]);
    await t.clock.advance(14 * MIN);
    expect(await t.api.listVideos()).toEqual([]);
    await t.clock.advance(1 * MIN);

    const [video] = await t.api.listVideos();
    expect(video).toMatchObject({ youtubeId: id(1), title: "New lesson", channelName: "Google Devs", durationSeconds: 600 });
    expect(video!.stages[0]).toMatchObject({ stage: "download" });
    expect(video).toMatchObject({ origin: "channel", channelId: channel.id });
    expect(sse.events.some((e) => e.youtubeId === id(1))).toBe(true);
    await sse.close();
  });

  test("the Channel records the last check, the next check and no error; SSE announces it", async () => {
    const t = setup();
    const sse = await t.subscribe();
    await add(t);
    const start = t.clock.now();
    await t.clock.advance(15 * MIN);
    expect(await t.api.listChannels()).toMatchObject([
      { lastCheckedAt: start + 15 * MIN, nextCheckAt: start + 30 * MIN, lastError: null },
    ]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listChannels())[0]).toMatchObject({ lastCheckedAt: start + 30 * MIN, nextCheckAt: start + 45 * MIN });
    expect(sse.channelEvents.at(-1)).toMatchObject({ lastCheckedAt: start + 30 * MIN });
    await sse.close();
  });

  test("a Video already detected is never processed twice", async () => {
    const t = setup();
    await add(t);
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(60 * MIN);
    expect(await t.api.listVideos()).toHaveLength(1);
    expect(t.fakes.lookups).toEqual([id(1)]);
  });

  test("a Video already requested ad hoc is not duplicated by the Channel", async () => {
    const t = setup();
    await add(t);
    await t.api.requestVideo(`https://www.youtube.com/watch?v=${id(1)}`);
    const lookups = t.fakes.lookups.length;
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toHaveLength(1);
    expect(t.fakes.lookups.length).toBe(lookups);
  });

  test("Shorts, lives and members videos are ignored with the reason and never become Videos", async () => {
    const t = setup();
    await add(t);
    const at = t.clock.now() + MIN;
    t.fakes.publish(id(2), { live_status: "was_live", was_live: true, media_type: "livestream" });
    t.fakes.publish(id(3), { live_status: "is_live", media_type: "livestream" });
    t.fakes.publish(id(4), { availability: "subscriber_only" });
    t.fakes.setFeed("UC_google", [listed(1, at, { isShort: true }), listed(2, at), listed(3, at), listed(4, at)]);
    await t.clock.advance(15 * MIN);

    expect(await t.api.listVideos()).toEqual([]);
    const ignored = await t.api.listIgnored();
    expect(ignored.map((i) => [i.youtubeId, i.why]).sort()).toEqual(
      [[id(1), "short"], [id(2), "live"], [id(3), "live"], [id(4), "members"]].sort(),
    );
    expect(ignored[0]).toMatchObject({ channelName: "Google Devs", reason: expect.any(String) });
    // a Short is known from the feed link alone: no metadata lookup
    expect(t.fakes.lookups).not.toContain(id(1));
    // and ignored publications are not looked up again
    await t.clock.advance(15 * MIN);
    expect(t.fakes.lookups.filter((l) => l === id(2))).toHaveLength(1);
    expect(await t.api.listIgnored()).toHaveLength(4);
  });

  test("the ignored list can be filtered by Channel", async () => {
    const t = setup();
    const google = await add(t);
    await add(t, "@NASA");
    const at = t.clock.now() + MIN;
    t.fakes.setFeed("UC_google", [listed(1, at, { isShort: true })]);
    t.fakes.setFeed("UC_nasa", [listed(2, at, { isShort: true })]);
    await t.clock.advance(15 * MIN);
    expect(await t.api.listIgnored()).toHaveLength(2);
    expect((await t.api.listIgnored(`?channelId=${google.id}`)).map((i) => i.youtubeId)).toEqual([id(1)]);
  });

  test("a premiere that is not available yet is deferred and enters when it becomes available", async () => {
    const t = setup();
    await add(t);
    t.fakes.publish(id(1), { live_status: "is_upcoming", media_type: "video" });
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toEqual([]);
    expect(await t.api.listIgnored()).toEqual([]);

    t.fakes.publish(id(1), { live_status: "not_live", media_type: "video" });
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toMatchObject([{ youtubeId: id(1) }]);
  });

  test("after downtime, what was published in the gap is recovered, up to what the feed carries", async () => {
    const dir = createTestApp().dataDir;
    const first = createTestApp(dir);
    first.fakes.addChannel(GOOGLE);
    await first.api.addChannel("@GoogleDevelopers");
    const since = first.clock.now();
    first.app.stop();

    // the service is down for a day; 15 videos fill the feed (the oldest ones dropped out of it)
    const feed = Array.from({ length: 15 }, (_, i) => listed(i + 1, since + (15 - i) * MIN));
    const second = createTestApp(dir, {
      clockStart: since + 24 * 60 * MIN,
      beforeStart: (fakes) => {
        fakes.addChannel(GOOGLE);
        fakes.setFeed("UC_google", feed);
      },
    });
    await second.clock.advance(0);
    const videos = await second.api.listVideos();
    expect(videos.map((v) => v.youtubeId).sort()).toEqual(feed.map((f) => f.youtubeId).sort());
  });
});

describe("failures", () => {
  test("a Channel whose feed fails shows the error and does not affect the others", async () => {
    const t = setup();
    await add(t);
    await add(t, "@NASA");
    t.fakes.setFeed("UC_google", new Error("feed fora do ar"));
    t.fakes.setFeed("UC_nasa", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);

    const [google, nasa] = await t.api.listChannels();
    expect(google).toMatchObject({ lastError: expect.stringContaining("feed fora do ar"), nextCheckAt: t.clock.now() + 15 * MIN });
    expect(nasa).toMatchObject({ lastError: null });
    expect(await t.api.listVideos()).toMatchObject([{ youtubeId: id(1) }]);

    t.fakes.setFeed("UC_google", [listed(2, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listChannels())[0]).toMatchObject({ lastError: null });
    expect((await t.api.listVideos()).map((v) => v.youtubeId).sort()).toEqual([id(1), id(2)]);
  });

  test("a blocked metadata lookup never drops or ignores the publication, and stops the burst", async () => {
    const t = setup();
    await add(t);
    const at = t.clock.now() + MIN;
    for (const n of [1, 2, 3]) t.fakes.publish(id(n), new Error("Sign in to confirm you’re not a bot"));
    t.fakes.setFeed("UC_google", [listed(1, at), listed(2, at + 1), listed(3, at + 2)]);
    await t.clock.advance(15 * MIN);

    expect(await t.api.listVideos()).toEqual([]);
    expect(await t.api.listIgnored()).toEqual([]);
    expect(t.fakes.lookups).toHaveLength(1); // global blocking: do not repeatedly hit the same blocked service
    expect((await t.api.listChannels())[0]!.lastError).toContain("not a bot");

    for (const n of [1, 2, 3]) t.fakes.publish(id(n), {});
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId).sort()).toEqual([id(1), id(2), id(3)]);
    expect((await t.api.listChannels())[0]!.lastError).toBeNull();
  });

  test("a failed metadata lookup for one publication does not hold back newer Videos in the same Channel", async () => {
    const t = setup();
    await add(t);
    const at = t.clock.now() + MIN;
    t.fakes.publish(id(1), new PublicationUnavailableError("This video has been removed"));
    t.fakes.setFeed("UC_google", [listed(1, at), listed(2, at + 1)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(2)]);
    expect((await t.api.listChannels())[0]!.lastError).toContain(id(1));
    expect(await t.api.listIgnored()).toEqual([]);
  });

  test("one unreadable publication does not hold back the newer ones of the same Channel", async () => {
    const t = setup();
    await add(t);
    const at = t.clock.now() + MIN;
    t.fakes.publish(id(1), { channel_id: null, live_status: null }); // private or removed: empty answer
    t.fakes.setFeed("UC_google", [listed(1, at), listed(2, at + 1)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(2)]);
    expect((await t.api.listChannels())[0]!.lastError).toContain(id(1));
    expect(await t.api.listIgnored()).toEqual([]);
  });

  test("a feed that never answers times out and does not delay the other Channels", async () => {
    const t = setup();
    await add(t);
    await add(t, "@NASA");
    t.fakes.setFeed("UC_google", "hang");
    t.fakes.setFeed("UC_nasa", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(1)]);
    const [google, nasa] = await t.api.listChannels();
    expect(nasa).toMatchObject({ lastError: null, lastCheckedAt: t.clock.now() });
    expect(google).toMatchObject({ lastCheckedAt: null });

    await t.clock.advance(MIN);
    const [timedOut] = await t.api.listChannels();
    expect(timedOut!.lastError).toContain("timed out");
    expect(timedOut!.nextCheckAt).toBe(t.clock.now() + 15 * MIN);
  });

  test("a metadata lookup that never answers times out and does not delay the other Channels", async () => {
    const t = setup();
    await add(t);
    await add(t, "@NASA");
    const at = t.clock.now() + MIN;
    t.fakes.publish(id(1), "hang");
    t.fakes.setFeed("UC_google", [listed(1, at)]);
    t.fakes.setFeed("UC_nasa", [listed(2, at)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(2)]);
    await t.clock.advance(MIN);
    expect((await t.api.listChannels())[0]!.lastError).toContain("timed out");
    expect(await t.api.listIgnored()).toEqual([]);
  });

  test("an unreadable (empty) metadata answer is retried, never taken as a video or ignored", async () => {
    const t = setup();
    await add(t);
    t.fakes.publish(id(1), { channel_id: null, live_status: null });
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toEqual([]);
    expect(await t.api.listIgnored()).toEqual([]);
    expect((await t.api.listChannels())[0]!.lastError).toBeTruthy();
    t.fakes.publish(id(1), {});
    await t.clock.advance(15 * MIN);
    expect(await t.api.listVideos()).toHaveLength(1);
  });
});

describe("pausing, resuming and removing a Channel", () => {
  test("a paused Channel is not checked, and the pause is announced", async () => {
    const t = setup();
    const sse = await t.subscribe();
    const channel = await add(t);
    expect((await t.api.pauseChannel(channel.id)).status).toBe(200);
    expect(await t.api.listChannels()).toMatchObject([{ status: "paused" }]);
    expect(sse.channelEvents.at(-1)).toMatchObject({ id: channel.id, status: "paused" });

    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(60 * MIN);
    expect(t.fakes.feedFetches.filter((c) => c === "UC_google").length).toBe(0);
    expect(await t.api.listVideos()).toEqual([]);
    await sse.close();
  });

  test("on resume, what was published during the pause is ignored and only later publications enter", async () => {
    const t = setup();
    const channel = await add(t);
    await t.api.pauseChannel(channel.id);
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + 10 * MIN)]);
    await t.clock.advance(30 * MIN);

    const resumedAt = t.clock.now();
    const res = await t.api.resumeChannel(channel.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "active", activeSince: resumedAt, nextCheckAt: resumedAt + 15 * MIN });

    t.fakes.setFeed("UC_google", [listed(1, resumedAt - 20 * MIN), listed(2, resumedAt + MIN)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(2)]);
    expect(await t.api.listIgnored()).toEqual([]);
  });

  test("resuming a Channel that is already active changes nothing", async () => {
    const t = setup();
    const channel = await add(t);
    t.fakes.publish(id(1), {});
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + 2 * MIN)]);
    await t.clock.advance(5 * MIN);
    const res = await t.api.resumeChannel(channel.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ activeSince: channel.activeSince, nextCheckAt: channel.nextCheckAt });
    await t.clock.advance(10 * MIN);
    expect((await t.api.listVideos()).map((v) => v.youtubeId)).toEqual([id(1)]);
  });

  test("pausing, resuming or removing an unknown Channel is a 404", async () => {
    const t = setup();
    expect((await t.api.pauseChannel(99)).status).toBe(404);
    expect((await t.api.resumeChannel(99)).status).toBe(404);
    expect((await t.api.removeChannel(99)).status).toBe(404);
  });

  test("removing a Channel stops following it and it can be added again, from now", async () => {
    const t = setup();
    const channel = await add(t);
    expect((await t.api.removeChannel(channel.id)).status).toBe(204);
    expect(await t.api.listChannels()).toEqual([]);
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(60 * MIN);
    expect(t.fakes.feedFetches.filter((c) => c === "UC_google").length).toBe(0);
    expect(await t.api.listVideos()).toEqual([]);

    const again = await add(t);
    expect(again.id).not.toBe(channel.id);
    expect(again.activeSince).toBe(t.clock.now());
  });

  test("Videos already in the pipeline finish after the Channel is paused or removed", async () => {
    const t = setup();
    const google = await add(t);
    const nasa = await add(t, "@NASA");
    t.fakes.publish(id(1), { channel: "Google Devs" });
    t.fakes.publish(id(2), { channel: "NASA" });
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    t.fakes.setFeed("UC_nasa", [listed(2, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN - 1); // just before the check, nothing yet
    await t.clock.advance(1);
    await t.api.pauseChannel(google.id);
    await t.api.removeChannel(nasa.id);
    await t.clock.advance(60_000);
    expect((await t.api.listVideos()).map((v) => [v.youtubeId, v.state]).sort()).toEqual([[id(1), "completed"], [id(2), "completed"]]);
  });

  test("a removed Channel's Videos keep its name and the costs page still groups them under it", async () => {
    const t = setup();
    const google = await add(t);
    t.fakes.publish(id(1), { channel: "Google Devs" });
    t.fakes.setFeed("UC_google", [listed(1, t.clock.now() + MIN)]);
    await t.clock.advance(15 * MIN);
    await t.clock.advance(60_000);
    const adhoc = await (await t.api.requestVideo(`https://www.youtube.com/watch?v=${id(9)}`)).json();
    await t.clock.advance(60_000);
    expect(adhoc.id).toBeGreaterThan(0);

    await t.api.removeChannel(google.id);
    const [video] = (await t.api.listVideos()).filter((v) => v.youtubeId === id(1));
    expect(video).toMatchObject({ channelName: "Google Devs", state: "completed" });
    const { byChannel } = await t.api.getCosts();
    expect(byChannel.map((g) => [g.channelId, g.name, g.generations])).toEqual([
      [google.id, "Google Devs", 1],
      [null, null, 1],
    ]);
  });
});
