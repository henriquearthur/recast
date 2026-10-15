import { describe, expect, test } from "bun:test";
import { classifyPublication } from "../src/server/classify";

const sample = (name: string) => Bun.file(`${import.meta.dir}/fixtures/ytdlp/${name}.json`).json();

describe("publication classification against recorded yt-dlp metadata", () => {
  test("an ordinary video is a video", async () => {
    expect(classifyPublication(await sample("video-ordinary"))).toEqual({ kind: "video" });
  });

  test("a Short is ignored with its reason", async () => {
    expect(classifyPublication(await sample("video-short"))).toMatchObject({ kind: "ignored", why: "short" });
  });

  test("a live in progress and an ended live are ignored as lives", async () => {
    expect(classifyPublication(await sample("video-live-in-progress"))).toMatchObject({ kind: "ignored", why: "live" });
    expect(classifyPublication(await sample("video-live-ended"))).toMatchObject({ kind: "ignored", why: "live" });
  });

  test("a members-only video is ignored", async () => {
    expect(classifyPublication(await sample("video-members-only"))).toMatchObject({ kind: "ignored", why: "members" });
  });

  test("an upcoming publication is deferred, not ignored", async () => {
    expect(classifyPublication(await sample("video-live-upcoming"))).toMatchObject({ kind: "deferred" });
  });

  // No real premiere in progress was ever recorded: this combination (live_status is_live while media_type is video,
  // not livestream) is inferred from the yt-dlp notes and is unverified against a real premiere.
  test("a premiere in progress (is_live but not a livestream) is deferred until it ends up available", async () => {
    const live = await sample("video-live-in-progress");
    expect(classifyPublication({ ...live, media_type: "video" })).toMatchObject({ kind: "deferred" });
    expect(classifyPublication(live)).toMatchObject({ kind: "ignored", why: "live" });
  });

  test("an empty answer for a private or missing video is unreadable, never a video", async () => {
    expect(classifyPublication(await sample("video-unavailable-or-private"))).toMatchObject({ kind: "unreadable" });
  });

  test("every refusal carries a message in Portuguese", async () => {
    const reasons = await Promise.all(
      ["video-short", "video-live-ended", "video-members-only"].map(async (n) => (classifyPublication(await sample(n)) as { reason: string }).reason),
    );
    expect(reasons).toEqual([
      "This is a Short; Recast only processes ordinary videos.",
      "This is a livestream (ongoing or completed); Recast only processes ordinary videos.",
      "This video is exclusive to channel members.",
    ]);
  });
});
