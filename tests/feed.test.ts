import { describe, expect, test } from "bun:test";
import { parseFeed } from "../src/server/feed";
import { interpretChannel } from "../src/server/ytdlp";
import { ChannelNotFoundError } from "../src/server/deps";

const read = (path: string) => Bun.file(`${import.meta.dir}/fixtures/${path}`);

describe("feed interpreter (real recorded feeds)", () => {
  test("Google feed: 15 entries, newest first, 5 of them Shorts", async () => {
    const publications = parseFeed(await read("feed/feed-google-for-developers.xml").text());
    expect(publications).toHaveLength(15);
    expect(publications[0]).toEqual({
      youtubeId: "8Xv5BLnXzgI",
      title: expect.any(String),
      publishedAt: Date.parse("2026-10-01T23:00:21+00:00"),
      isShort: true,
    });
    expect(publications.filter((p) => p.isShort)).toHaveLength(5);
    expect(publications.every((p) => /^[\w-]{11}$/.test(p.youtubeId))).toBe(true);
  });

  test("NASA feed: video ids starting with a dash survive, lives look like ordinary videos, one Short", async () => {
    const publications = parseFeed(await read("feed/feed-nasa-with-live-and-short.xml").text());
    expect(publications).toHaveLength(15);
    expect(publications[0]).toMatchObject({ youtubeId: "-62C9R_41Sc", title: "From the Moon to the 50-Yard Line", isShort: true });
    expect(publications.filter((p) => p.isShort)).toHaveLength(1);
    expect(publications.find((p) => p.youtubeId === "7ZiUbT1-djA")).toMatchObject({ isShort: false });
    expect(publications.find((p) => p.youtubeId === "dGSqblvgLIE")).toMatchObject({ isShort: false });
  });

  test("XML entities in titles are decoded", () => {
    const xml = `<feed><entry><yt:videoId>aaaaaaaaaaa</yt:videoId><title>A &amp; B &lt;3 &quot;x&quot; &#39;y&#39;</title>
      <link rel="alternate" href="https://www.youtube.com/watch?v=aaaaaaaaaaa"/><published>2026-01-01T00:00:00+00:00</published></entry></feed>`;
    expect(parseFeed(xml)[0]!.title).toBe(`A & B <3 "x" 'y'`);
  });
});

describe("channel interpreter (real recorded channel page)", () => {
  test("reads the canonical id, name, handle and the square avatar", async () => {
    expect(interpretChannel(await read("ytdlp/channel-handle.json").json())).toEqual({
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      name: "Google for Developers",
      handle: "@GoogleDevelopers",
      imageUrl: expect.stringContaining("yt3.googleusercontent.com"),
    });
  });

  test("a video pasted as a channel is not a channel", async () => {
    expect(() => interpretChannel(await_video())).toThrow(ChannelNotFoundError);
  });
});

function await_video() {
  return { id: "jNQXAC9IVRw", channel_id: "UC4QobU6STFB0P71PMvOGN5A", title: "Me at the zoo" };
}
