import { describe, expect, test } from "bun:test";
import { parseArticle, readingMinutes } from "../src/article";
import { markdownToHtml } from "../src/markdown";
import { Settings } from "../src/server/settings";
import { openDatabase } from "../src/server/db";
import { createTestApp } from "./harness";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("stats", () => {
  test("adds up what was produced, per day, per stage and per origin", async () => {
    const t = createTestApp();
    t.fakes.publish("aaaaaaaaaaa", { duration: 600, timestamp: 1_600_000_000 });
    const { id } = await (await t.api.requestVideo("https://www.youtube.com/watch?v=aaaaaaaaaaa")).json();
    await t.api.requestVideo("https://www.youtube.com/watch?v=bbbbbbbbbbb");
    await t.clock.advance(5_000); // the first one is still downloading
    let s = await (await t.request("/api/stats")).json();
    expect(s).toMatchObject({ videos: 2, articles: 0, watchSeconds: 0 });
    await t.clock.advance(120_000);
    s = await (await t.request("/api/stats")).json();
    expect(s).toMatchObject({ videos: 2, articles: 2, watchSeconds: 619 });
    expect(s.readWords).toBeGreaterThan(0);
    expect(s.daily).toHaveLength(1);
    expect(s.daily[0]).toMatchObject({ videos: 2, articles: 2, inputTokens: 2400 });
    expect(s.stages.map((x: any) => [x.stage, x.done, x.failed])).toEqual([["download", 2, 0], ["transcription", 2, 0], ["article", 2, 0], ["delivery", 2, 0]]);
    expect(s.stages[0].avgMs).toBe(4000);
    expect(s.channels).toEqual([expect.objectContaining({ channelId: null, videos: 2, articles: 2 })]);
    expect((await t.api.getVideo(id) as any).publishedAt).toBe(1_600_000_000_000);
  });
});

describe("article shape", () => {
  test("the summary is the text before the first heading, or a first section called TL;DR", () => {
    const loose = parseArticle("- one\n- two\n\n## Section A [01:05]\nText.\n\n## Section B\nMore.");
    expect(loose.summary).toBe("- one\n- two");
    expect(loose.sections).toEqual([{ title: "Section A", timecode: "01:05", seconds: 65 }, { title: "Section B", timecode: null, seconds: null }]);
    const titled = parseArticle("## TL;DR\n- one\n\n## Section A\nText.");
    expect(titled.summary).toBe("- one");
    expect(titled.body).toBe("## Section A\nText.");
    expect(parseArticle("## Section A\nText.").summary).toBe("");
    // While the summary is still being written there is no heading yet.
    expect(parseArticle("- one\n- tw").body).toBe("");
    expect(readingMinutes(parseArticle("word ".repeat(900)).words)).toBe(5);
  });

  test("ordered lists, quotes and code are rendered", () => {
    expect(markdownToHtml("1. one\n2. two\n\n> quote\n\nwith `code`")).toBe("<ol>\n<li>one</li>\n<li>two</li>\n</ol>\n<blockquote>quote</blockquote>\n<p>with <code>code</code></p>");
  });
});

describe("global prompt default", () => {
  test("a stored prompt that is just an older default follows the current default; a customized one is kept", () => {
    const db = openDatabase(mkdtempSync(join(tmpdir(), "recast-test-")));
    // A default from an earlier version, when Articles were always written in Brazilian Portuguese.
    const old = readFileSync(join(import.meta.dir, "fixtures/settings/legacy-global-prompt.txt"), "utf8");
    new Settings(db).set("globalPrompt", old);
    expect(new Settings(db).get("globalPrompt")).toContain("## TL;DR");
    new Settings(db).set("globalPrompt", "My prompt.");
    expect(new Settings(db).get("globalPrompt")).toBe("My prompt.");
  });

  test("an installation from before the Article language setting keeps writing in Brazilian Portuguese; a new one writes in English", () => {
    const dir = mkdtempSync(join(tmpdir(), "recast-test-"));
    const legacy = openDatabase(dir);
    legacy.run("INSERT INTO settings (key, value) VALUES ('recipient', 'me@example.com')");
    legacy.run("INSERT INTO ignored_publications VALUES ('aaaaaaaaaaa', 1, 'Channel', NULL, 0, 'short', 'É um Short; o Recast só processa vídeos.', 0)");
    legacy.run("PRAGMA user_version = 0");
    legacy.close();
    const upgraded = openDatabase(dir);
    expect(new Settings(upgraded).get("articleLanguage")).toBe("pt-BR");
    expect(upgraded.query<{ reason: string }, []>("SELECT reason FROM ignored_publications").get()!.reason).toBe("This is a Short; Recast only processes ordinary videos.");
    expect(new Settings(openDatabase(mkdtempSync(join(tmpdir(), "recast-test-")))).get("articleLanguage")).toBe("en");
  });
});
