import { afterEach, describe, expect, test } from "bun:test";
import { createTestApp } from "./harness";

const url = (c: string) => `https://www.youtube.com/watch?v=${c.repeat(11)}`;
const DAY = 86_400_000;

async function generate(t: ReturnType<typeof createTestApp>, c: string) {
  const { id } = await (await t.api.requestVideo(url(c))).json();
  await t.clock.advance(60_000);
  return id as number;
}

describe("global costs", () => {
  test("empty database has zero totals and no groups", async () => {
    const t = createTestApp();
    expect(await t.api.getCosts()).toEqual({
      total: { inputTokens: 0, outputTokens: 0, credits: 0, generations: 0, costUsd: 0, unknownCosts: 0, unknownUsage: 0 },
      byDay: [],
      byProvider: [],
      byMonth: [],
      byChannel: [],
      byModel: [],
    });
  });

  test("totals, months and models aggregate every usage record, regenerations included", async () => {
    const t = createTestApp(undefined, { clockStart: Date.UTC(2023, 10, 14, 12) }); // November
    const a = await generate(t, "a");
    await t.api.putSetting("model", "gpt-5.4-mini");
    await t.clock.advance(20 * DAY); // December
    await generate(t, "b");
    await t.request(`/api/videos/${a}/regenerate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await t.clock.advance(60_000);

    const costs = await t.api.getCosts();
    expect(costs.total).toMatchObject({ inputTokens: 3 * 1200, outputTokens: 3 * 300, generations: 3 });
    expect(costs.total.credits).toBeCloseTo(3 * 0.027, 10);
    expect(costs.byMonth.map((m) => [m.month, m.generations, m.inputTokens])).toEqual([
      ["2023-11", 1, 1200],
      ["2023-12", 2, 2400],
    ]);
    expect(costs.byModel.map((m) => [m.model, m.generations, m.inputTokens])).toEqual([
      ["gpt-5.4-mini", 2, 2400],
      ["gpt-6-luna", 1, 1200],
    ]);
  });

  describe("months follow the server's local time zone", () => {
    const original = process.env.TZ;
    afterEach(() => {
      process.env.TZ = original ?? "UTC"; // assigning (not deleting) is what makes the runtime re-read the zone
    });

    test("a generation just after midnight UTC on the 1st still belongs to the previous month west of Greenwich", async () => {
      process.env.TZ = "America/Sao_Paulo"; // UTC-3: 2023-12-01 01:00Z is 2023-11-30 22:00 locally
      const t = createTestApp(undefined, { clockStart: Date.UTC(2023, 11, 1, 0, 59, 30) });
      await generate(t, "a");
      expect((await t.api.getCosts()).byMonth.map((m) => m.month)).toEqual(["2023-11"]);
    });

    test("a generation late on the last day UTC already belongs to the next month east of Greenwich", async () => {
      process.env.TZ = "Pacific/Kiritimati"; // UTC+14: 2023-11-30 12:00Z is 2023-12-01 02:00 locally
      const t = createTestApp(undefined, { clockStart: Date.UTC(2023, 10, 30, 11, 59, 30) });
      await generate(t, "a");
      expect((await t.api.getCosts()).byMonth.map((m) => m.month)).toEqual(["2023-12"]);
    });
  });

  test("ad hoc videos form their own group and videos of a followed Channel group per Channel", async () => {
    const t = createTestApp();
    t.fakes.addChannel({ channelId: "UC_one", name: "Channel One", handle: "@one", imageUrl: null });
    t.fakes.addChannel({ channelId: "UC_two", name: "Channel Two", handle: "@two", imageUrl: null });
    const one = await (await t.api.addChannel("@one")).json();
    const two = await (await t.api.addChannel("@two")).json();
    const at = t.clock.now() + 1;
    const listed = (c: string, n: number) => ({ youtubeId: c.repeat(11), title: `V${n}`, publishedAt: at + n, isShort: false });
    t.fakes.setFeed("UC_one", [listed("b", 1), listed("c", 2)]);
    t.fakes.setFeed("UC_two", [listed("d", 3)]);
    await t.clock.advance(15 * 60_000);
    await generate(t, "a");

    const { byChannel } = await t.api.getCosts();
    expect(byChannel.map((g) => [g.channelId, g.name, g.generations, g.inputTokens])).toEqual([
      [one.id, "Channel One", 2, 2400],
      [two.id, "Channel Two", 1, 1200],
      [null, null, 1, 1200],
    ]);
  });
});
