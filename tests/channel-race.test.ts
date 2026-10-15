import { expect, test } from "bun:test";
import type { ListedPublication, PublicationFeed } from "../src/server/deps";
import type { PublicationInfo } from "../src/server/classify";
import { createTestApp } from "./harness";

const MIN = 60_000;
const publication = (youtubeId: string, publishedAt: number): ListedPublication => ({ youtubeId, publishedAt, title: "Publication", isShort: false });
const deferred = <T>() => {
  let release!: (value: T) => void;
  const pending = new Promise<T>((resolve) => { release = resolve; });
  return { pending, release };
};
async function setup(boundary: "feed" | "metadata") {
  const t = createTestApp();
  t.fakes.addChannel({ channelId: "UC_test", name: "Test", handle: "@test", imageUrl: null });
  const channel = await (await t.api.addChannel("@test")).json();
  const delayedFeed = deferred<ListedPublication[]>();
  const delayedMetadata = deferred<PublicationInfo>();
  const ordinary: PublicationInfo = { channel_id: "UC_test", live_status: "not_live", media_type: "video" };
  const savedFeed: PublicationFeed["fetchFeed"] = t.fakes.deps.feed.fetchFeed;
  const savedMetadata = t.fakes.deps.metadata.lookup;
  if (boundary === "feed") t.fakes.deps.feed.fetchFeed = () => delayedFeed.pending;
  else {
    t.fakes.setFeed("UC_test", [publication("aaaaaaaaaaa", t.clock.now() + MIN)]);
    t.fakes.deps.metadata.lookup = () => delayedMetadata.pending;
  }
  await t.clock.advance(15 * MIN);
  return { t, channel, release: (at: number, short = false) => {
    delayedFeed.release([publication("aaaaaaaaaaa", at), { ...publication("bbbbbbbbbbb", at), isShort: true }]);
    delayedMetadata.release(short ? { ...ordinary, media_type: "short" } : ordinary);
    t.fakes.deps.feed.fetchFeed = savedFeed;
    t.fakes.deps.metadata.lookup = savedMetadata;
  } };
}

for (const boundary of ["feed", "metadata"] as const) {
  for (const action of ["pause", "remove"] as const) {
    test(`${action} invalidates a pending ${boundary} answer before it queues Videos or saves ignored publications`, async () => {
      const { t, channel, release } = await setup(boundary);
      if (action === "pause") await t.api.pauseChannel(channel.id);
      else await t.api.removeChannel(channel.id);
      await t.clock.advance(1000);
      release(t.clock.now(), true);
      await t.clock.advance(0);
      expect(await t.api.listVideos()).toEqual([]);
      expect(await t.api.listIgnored()).toEqual([]);
      const channels = await t.api.listChannels();
      if (action === "pause") expect(channels[0]).toMatchObject({ status: "paused", lastCheckedAt: null });
      else expect(channels).toEqual([]);
    });
  }
  test(`reactivation ignores the previous ${boundary} answer and keeps the new active-since/check marks`, async () => {
    const { t, channel, release } = await setup(boundary);
    await t.api.pauseChannel(channel.id);
    await t.clock.advance(1000);
    const duringPause = t.clock.now();
    await t.clock.advance(1000);
    await t.api.resumeChannel(channel.id);
    const reactivated = (await t.api.listChannels())[0]!;
    await t.clock.advance(1000);
    release(duringPause);
    await t.clock.advance(0);
    expect(await t.api.listVideos()).toEqual([]);
    expect(await t.api.listIgnored()).toEqual([]);
    expect((await t.api.listChannels())[0]).toEqual(reactivated);
    t.fakes.setFeed("UC_test", [publication("aaaaaaaaaaa", duringPause), publication("ccccccccccc", reactivated.activeSince + 1)]);
    await t.clock.advance(15 * MIN);
    expect((await t.api.listVideos()).map((video) => video.youtubeId)).toEqual(["ccccccccccc"]);
  });
}

test("pause/resume at the same clock instant still invalidates the previous check", async () => {
  const { t, channel, release } = await setup("feed");
  await t.api.pauseChannel(channel.id);
  await t.api.resumeChannel(channel.id);
  release(t.clock.now() + 1);
  await t.clock.advance(0);
  expect(await t.api.listVideos()).toEqual([]);
  expect(await t.api.listIgnored()).toEqual([]);
  expect((await t.api.listChannels())[0]!.lastCheckedAt).toBeNull();
});
