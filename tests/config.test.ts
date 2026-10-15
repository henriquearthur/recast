import { expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

test("data directory comes from RECAST_DATA_DIR", () => {
  expect(loadConfig({ RECAST_DATA_DIR: "/srv/recast-data" }).dataDir).toBe("/srv/recast-data");
});

test("data directory defaults to a per-user location outside the repository", () => {
  const { dataDir } = loadConfig({ HOME: "/home/someone" });
  expect(dataDir).toBe("/home/someone/.local/share/recast");
});

test("listens only on this machine unless RECAST_HOST says otherwise", () => {
  expect(loadConfig({}).host).toBe("127.0.0.1");
  expect(loadConfig({ RECAST_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
});

test("YouTube bypass is optional and accepts only a local IPv4 address", () => {
  expect(loadConfig({}).youtubeSourceAddress).toBeUndefined();
  expect(loadConfig({ RECAST_YOUTUBE_SOURCE_ADDRESS: " 192.168.1.10 " }).youtubeSourceAddress).toBe("192.168.1.10");
  expect(() => loadConfig({ RECAST_YOUTUBE_SOURCE_ADDRESS: "wlp2s0" })).toThrow("IPv4");
});
