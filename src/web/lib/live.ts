import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
import type { ChannelView } from "../../server/channels";
import type { Costs } from "../../server/costs";
import type { VideoView } from "../../server/pipeline";
import type { Stats } from "../../server/stats";

/** One SSE connection for the whole UI; every screen listens through it. */
let source: EventSource | null = null;
const events = () => (source ??= new EventSource("/api/events"));

export function onEvent(name: string, listener: (data: any) => void): () => void {
  const handle = (e: Event) => listener(name === "open" ? null : JSON.parse((e as MessageEvent).data));
  events().addEventListener(name, handle);
  return () => events().removeEventListener(name, handle);
}

export const api = {
  get: async <T,>(path: string): Promise<T> => (await fetch(path)).json(),
  /** Answers the parsed body, or throws the error message the server gave. */
  async send<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? t("Could not complete the action."));
    return data as T;
  },
};

/** Loads the current state, then keeps it fresh from SSE; every (re)connection reloads state first. */
export function useVideos() {
  const [videos, setVideos] = useState<Record<number, VideoView> | null>(null);
  const seen = useRef<Record<number, VideoView>>({});
  useEffect(() => {
    const load = async () => {
      const list = await api.get<VideoView[]>("/api/videos");
      seen.current = Object.fromEntries(list.map((v) => [v.id, v]));
      setVideos(seen.current);
    };
    void load();
    const off = [
      onEvent("open", load),
      onEvent("video", (v: VideoView) => {
        // Queue positions of the other videos move when a stage starts or ends: reload on any status change.
        const sig = (x?: VideoView) => x?.stages.map((s) => `${s.status}${s.attempts}`).join();
        if (sig(seen.current[v.id]) !== sig(v)) void load();
        seen.current[v.id] = v;
        setVideos((prev) => ({ ...prev, [v.id]: v }));
      }),
      // Article text arrives piece by piece; a piece is applied only if it continues exactly where the text ends.
      onEvent("article_chunk", (c: { id: number; offset: number; delta: string }) => {
        setVideos((prev) => {
          const v = prev?.[c.id];
          const replacing = v?.article?.complete === true;
          const text = (replacing ? v?.article?.draft : v?.article?.markdown) ?? "";
          if (!v || text.length !== c.offset) return prev;
          return {
            ...prev,
            [c.id]: {
              ...v,
              article: replacing ? { ...v.article!, draft: text + c.delta } : { markdown: text + c.delta, complete: false, usage: null, draft: null },
            },
          };
        });
      }),
    ];
    return () => off.forEach((f) => f());
  }, []);
  return videos === null ? null : Object.values(videos).sort((a, b) => b.id - a.id);
}

export function useChannels() {
  const [channels, setChannels] = useState<ChannelView[] | null>(null);
  const reload = async () => setChannels(await api.get<ChannelView[]>("/api/channels"));
  useEffect(() => {
    void reload();
    const off = [onEvent("open", reload), onEvent("channel", reload), onEvent("channel_removed", reload)];
    return () => off.forEach((f) => f());
  }, []);
  return { channels, reload };
}

/** Refetches `path` whenever `key` changes. */
function useResource<T>(path: string, key: string) {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let current = true;
    void api.get<T>(path).then((d) => current && setData(d));
    return () => {
      current = false;
    };
  }, [path, key]);
  return data;
}

/** Changes whenever a Video enters or changes state: what the aggregated numbers depend on. */
export const progressKey = (videos: VideoView[] | null) => (videos ?? []).map((v) => `${v.id}${v.state[0]}${v.article?.complete ? 1 : 0}`).join();

export const useStats = (videos: VideoView[] | null) => useResource<Stats>("/api/stats", progressKey(videos));
export const useCosts = (videos: VideoView[] | null) => useResource<Costs>("/api/costs", progressKey(videos));

/** Re-renders every `ms`, for countdowns and relative timestamps. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
