import { describe, expect, test } from "bun:test";
import type { ResolvedChannel } from "../src/server/deps";
import { createTestApp } from "./harness";

const MIN = 60_000;
const GOOGLE: ResolvedChannel = { channelId: "UC_google", name: "Google Devs", handle: "@GoogleDevelopers", imageUrl: null };
const NASA: ResolvedChannel = { channelId: "UC_nasa", name: "NASA", handle: "@NASA", imageUrl: null };
const id = (n: number) => `vid${String(n).padStart(8, "0")}`;
const listed = (n: number, at: number) => ({ youtubeId: id(n), title: `Video ${n}`, publishedAt: at, isShort: false });

/** Google publishes videos 1 and 2, NASA video 3, and video 4 is requested by hand (ad hoc). */
async function setup() {
  const t = createTestApp();
  t.fakes.addChannel(GOOGLE);
  t.fakes.addChannel(NASA);
  const google = await (await t.api.addChannel("@GoogleDevelopers")).json();
  await t.clock.advance(1); // distinct check times: creation order is independent of simultaneous Channel checks
  const nasa = await (await t.api.addChannel("@NASA")).json();
  for (const n of [1, 2, 3, 4]) t.fakes.publish(id(n), { title: `Video ${n}`, channel: n === 3 ? "NASA" : "Google Devs", duration: 60 });
  const now = t.clock.now();
  t.fakes.setFeed("UC_google", [listed(1, now + 1), listed(2, now + 2)]);
  t.fakes.setFeed("UC_nasa", [listed(3, now + 3)]);
  await t.clock.advance(15 * MIN);
  await t.api.requestVideo(`https://www.youtube.com/watch?v=${id(4)}`);
  await t.clock.advance(60_000);
  return { t, google, nasa };
}
const get = async (t: Awaited<ReturnType<typeof setup>>["t"], path: string) => (await t.request(path)).json();
const ids = (list: { youtubeId: string }[]) => list.map((v) => v.youtubeId);

describe("article list", () => {
  test("lists ready Articles newest first, with ad hoc ones", async () => {
    const { t } = await setup();
    expect(ids(await get(t, "/api/articles"))).toEqual([id(4), id(3), id(2), id(1)]);
  });

  test("leaves out videos whose Article is not ready", async () => {
    const { t } = await setup();
    await t.api.requestVideo(`https://www.youtube.com/watch?v=${id(5)}`);
    await t.clock.advance(9_000); // the Article of video 5 is being written
    expect((await t.api.getVideo(5)).article).toMatchObject({ complete: false });
    expect(ids(await get(t, "/api/articles"))).toEqual([id(4), id(3), id(2), id(1)]);
  });

  test("filters by Channel and by the ad hoc group", async () => {
    const { t, google, nasa } = await setup();
    expect(ids(await get(t, `/api/articles?channelId=${google.id}`))).toEqual([id(2), id(1)]);
    expect(ids(await get(t, `/api/articles?channelId=${nasa.id}`))).toEqual([id(3)]);
    expect(ids(await get(t, "/api/articles?channelId=adhoc"))).toEqual([id(4)]);
  });
});

describe("video list", () => {
  test("shows every video with origin, state and stages", async () => {
    const { t } = await setup();
    const list = await get(t, "/api/videos");
    expect(list).toHaveLength(4);
    expect(list.map((v: any) => [v.youtubeId, v.origin, v.channelName])).toEqual([
      [id(4), "ad_hoc", "Google Devs"],
      [id(3), "channel", "NASA"],
      [id(2), "channel", "Google Devs"],
      [id(1), "channel", "Google Devs"],
    ]);
  });

  test("filters by Channel, by state and by the ad hoc group", async () => {
    const { t, google } = await setup();
    t.fakes.fail("download", 3);
    await t.api.requestVideo(`https://www.youtube.com/watch?v=${id(5)}`); // ad hoc, fails
    await t.clock.advance(10 * MIN);
    t.fakes.fail("download", 3);
    t.fakes.publish(id(6), { title: "Video 6", channel: "Google Devs", duration: 60 });
    t.fakes.setFeed("UC_google", [listed(6, t.clock.now() + 1)]);
    await t.clock.advance(30 * MIN); // detected, then fails
    expect(ids(await get(t, `/api/videos?channelId=${google.id}`))).toEqual([id(6), id(2), id(1)]);
    expect(ids(await get(t, "/api/videos?channelId=adhoc"))).toEqual([id(5), id(4)]);
    expect(ids(await get(t, "/api/videos?state=failed"))).toEqual([id(6), id(5)]);
    expect(ids(await get(t, `/api/videos?channelId=${google.id}&state=failed`))).toEqual([id(6)]);
    expect(ids(await get(t, "/api/videos?channelId=adhoc&state=failed"))).toEqual([id(5)]);
  });

  test("a video keeps its ad hoc origin even if it has a Channel name, and a removed Channel does not make it ad hoc", async () => {
    const { t, google } = await setup();
    expect((await t.api.removeChannel(google.id)).status).toBe(204);
    expect(ids(await get(t, "/api/videos?channelId=adhoc"))).toEqual([id(4)]);
    expect((await get(t, "/api/videos")).find((v: any) => v.youtubeId === id(1))).toMatchObject({ origin: "channel" });
  });
});
