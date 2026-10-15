import { Providers, type GenerationAdapters } from "./providers";
import { isGenerationProvider, providerName, type GenerationProvider } from "./generation";
import { Channels } from "./channels";
import { classifyPublication, durationSeconds, publishedAt } from "./classify";
import type { Clock } from "./clock";
import { costs } from "./costs";
import { stats } from "./stats";
import { openDatabase } from "./db";
import { Detection, LOOKUP_TIMEOUT_MS } from "./detection";
import type { HealthCheck } from "./health";
import { ChannelNotFoundError, type Deps } from "./deps";
import { errorMessage } from "./errors";
import { Pipeline, type Outcome, type VideoView } from "./pipeline";
import { isSettingKey, Settings } from "./settings";
import { withTimeout } from "./timeout";
import { parseYoutubeId } from "./youtube";

export interface AppOptions {
  dataDir: string;
  clock: Clock;
  deps: Deps;
  /** Public address of the UI, used for links in e-mails. */
  baseUrl?: string;
  /** Dependency health check behind `/api/health`; absent means everything is considered fine. */
  health?: HealthCheck;
  generation?: GenerationAdapters;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

/** The application seam: a fetch handler (HTTP + SSE) over a pipeline backed by SQLite in `dataDir`. */
export function createApp({ dataDir, clock, deps, baseUrl = "http://localhost:4280", health, generation }: AppOptions) {
  const db = openDatabase(dataDir);
  const settings = new Settings(db);
  const providers = generation ? new Providers(db, generation, clock.now) : undefined;
  if (providers) deps = { ...deps, writer: providers.writer };
  const pipeline = new Pipeline(db, deps, clock, baseUrl, settings);
  const channels = new Channels(db, deps.resolver, clock);
  const detection = new Detection(db, deps, clock, channels, pipeline);

  const channelError = (err: unknown) =>
    err instanceof ChannelNotFoundError
      ? json({ error: err.message }, 404)
      : json({ error: `Could not look up the channel: ${errorMessage(err)}` }, 502);

  /** Maps the outcome of a command on one video (or Channel) to its HTTP answer. */
  const answer = <T>(result: Outcome<T>, notFound: string, conflict = "Action unavailable for the current video state") =>
    result === "not_found" ? json({ error: notFound }, 404) : result === "conflict" ? json({ error: conflict }, 409) : json(result);

  const isLanguageCode = (value: string) => {
    try { return Intl.getCanonicalLocales(value)[0] === value; } catch { return false; }
  };

  async function validateSettings(values: Record<string, unknown>): Promise<Response | null> {
    for (const [key, value] of Object.entries(values)) {
      if (!isSettingKey(key)) return json({ error: "Unknown setting" }, 404);
      if (typeof value !== "string") return json({ error: "Invalid value" }, 400);
      if (key === "provider" && !isGenerationProvider(value)) return json({ error: "Invalid generation provider." }, 400);
      if (key === "articleLanguage" && !isLanguageCode(value)) return json({ error: "Use a language code such as en, pt-BR, or es." }, 400);
      const provider = key === "model" ? "copilot" : key.endsWith("Model") ? key.slice(0, -5) as GenerationProvider : null;
      if (provider && value !== (key === "model" ? settings.get("model") : settings.generationModel(provider)) && value) {
        const catalog = providers ? await providers.catalog(provider) : null;
        if (catalog && !catalog.models.some((m) => m.id === value)) return json({ error: "Choose a model from the online catalog." }, 400);
      }
    }
    return null;
  }

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/api/videos" && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
      const youtubeId = typeof body?.url === "string" ? parseYoutubeId(body.url) : null;
      if (!youtubeId) return json({ error: "Invalid YouTube video URL" }, 400);
      const existing = pipeline.findByYoutubeId(youtubeId);
      if (existing) return json(existing, 200);
      let info;
      try {
        info = await withTimeout(clock, LOOKUP_TIMEOUT_MS, "The request timed out.", (signal) => deps.metadata.lookup(youtubeId, signal));
      } catch (err) {
        return json({ error: `Could not look up the video: ${errorMessage(err)}` }, 502);
      }
      const verdict = classifyPublication(info);
      if (verdict.kind === "unreadable") return json({ error: verdict.reason }, 502);
      if (verdict.kind !== "video") return json({ error: verdict.reason }, 422);
      const { video, created } = pipeline.request(youtubeId, body!.url as string, {
        title: info.title,
        channelName: info.channel,
        durationSeconds: durationSeconds(info),
        publishedAt: publishedAt(info),
      });
      return json(video, created ? 201 : 200);
    }
    if ((pathname === "/api/videos" || pathname === "/api/articles") && req.method === "GET") {
      const q = new URL(req.url).searchParams;
      const channel = q.get("channelId");
      const state = q.get("state") as VideoView["state"] | null;
      return json(
        pipeline.list({
          origin: channel === "adhoc" ? "ad_hoc" : undefined,
          channelId: channel && channel !== "adhoc" ? Number(channel) : undefined,
          state: state ?? undefined,
          articleReady: pathname === "/api/articles",
        }),
      );
    }

    const match = pathname.match(/^\/api\/videos\/(\d+)$/);
    if (match && req.method === "GET") {
      const video = pipeline.view(Number(match[1]));
      return video ? json(video) : json({ error: "Video not found" }, 404);
    }

    if (pathname === "/api/channels" && req.method === "GET") return json(channels.list());
    if ((pathname === "/api/channels" || pathname === "/api/channels/resolve") && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { input?: unknown } | null;
      if (typeof body?.input !== "string" || !body.input.trim()) return json({ error: "Provide the channel URL or @handle" }, 400);
      try {
        if (pathname === "/api/channels/resolve") return json(await channels.resolve(body.input));
        const channel = await channels.add(body.input);
        return channel === "exists" ? json({ error: "This channel has already been added." }, 409) : json(channel, 201);
      } catch (err) {
        return channelError(err);
      }
    }
    const channelMatch = pathname.match(/^\/api\/channels\/(\d+)(?:\/(pause|resume))?$/);
    if (channelMatch) {
      const id = Number(channelMatch[1]);
      const action = channelMatch[2];
      let result: unknown = null;
      if (!action && req.method === "PATCH") {
        const body = (await req.json().catch(() => null)) as { instructions?: unknown } | null;
        if (typeof body?.instructions !== "string") return json({ error: "Provide Channel Instructions" }, 400);
        result = channels.setInstructions(id, body.instructions);
      } else if (action && req.method === "POST") result = action === "pause" ? channels.pause(id) : channels.resume(id);
      else if (!action && req.method === "DELETE") {
        if (channels.remove(id)) return new Response(null, { status: 204 });
      } else return json({ error: "Method not allowed" }, 405);
      return result ? json(result) : json({ error: "Channel not found" }, 404);
    }
    if (pathname === "/api/ignored" && req.method === "GET") {
      const channelId = new URL(req.url).searchParams.get("channelId");
      return json(detection.ignored(channelId ? Number(channelId) : undefined));
    }

    if (pathname === "/api/health" && req.method === "GET") {
      const report = health ? await health() : { ok: true, problems: [] };
      if (!providers) return json(report);
      const selected = settings.get("provider") as GenerationProvider;
      const status = (await providers.status(selected))[0]!;
      const problems = [...report.problems];
      if (status.state !== "authenticated") problems.push({ key: "generation", message: `${providerName[selected]}: ${status.detail ?? "authentication not verified."}` });
      if (!settings.generationModel(selected)) problems.push({ key: "generation", message: "No generation model selected: choose one in Settings." });
      return json({ ok: !problems.length, problems });
    }
    if (pathname === "/api/providers" && req.method === "GET") return json(providers ? await providers.status() : []);
    const catalog = pathname.match(/^\/api\/providers\/(copilot|claude|codex)\/models$/);
    if (catalog && (req.method === "GET" || req.method === "POST")) {
      if (!providers) return json({ models: [], updatedAt: null, error: "Catalog unavailable in this environment." });
      return json(await providers.catalog(catalog[1] as GenerationProvider, req.method === "POST"));
    }

    if (pathname === "/api/costs" && req.method === "GET") return json(costs(db));

    if (pathname === "/api/stats" && req.method === "GET") return json(stats(db));

    if (pathname === "/api/settings" && req.method === "GET") return json(settings.all());
    if (pathname === "/api/settings" && req.method === "PUT") {
      const body = await req.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid value" }, 400);
      const invalid = await validateSettings(body);
      if (invalid) return invalid;
      db.transaction(() => { for (const [key, value] of Object.entries(body)) settings.set(key as import("./settings").SettingKey, value as string); })();
      return json(settings.all());
    }

    const command = pathname.match(/^\/api\/videos\/(\d+)\/(retry|cancel|resume)$/);
    if (command && req.method === "POST") {
      return answer(pipeline[command[2] as "retry" | "cancel" | "resume"](Number(command[1])), "Video not found");
    }
    const regen = pathname.match(/^\/api\/videos\/(\d+)\/regenerate$/);
    if (regen && req.method === "POST") {
      const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
      if (body?.model !== undefined) return json({ error: "Choose the global model in Settings." }, 400);
      return answer(
        pipeline.regenerate(Number(regen[1])),
        "Video not found",
        "Only articles from completed videos can be regenerated",
      );
    }
    const attempts = pathname.match(/^\/api\/videos\/(\d+)\/attempts$/);
    if (attempts && req.method === "GET") {
      return answer(pipeline.attempts(Number(attempts[1])), "Video not found");
    }

    const transcript = pathname.match(/^\/api\/videos\/(\d+)\/transcript$/);
    if (transcript && req.method === "GET") {
      const result = pipeline.transcript(Number(transcript[1]));
      return result ? json(result) : json({ error: "Transcript not found" }, 404);
    }

    const article = pathname.match(/^\/api\/videos\/(\d+)\/article$/);
    if (article && req.method === "GET") {
      const markdown = pipeline.article(Number(article[1]));
      return markdown === null ? json({ error: "Article not found" }, 404) : json({ markdown });
    }

    const email = pathname.match(/^\/api\/videos\/(\d+)\/email$/);
    if (email && req.method === "GET") {
      const rendered = pipeline.email(Number(email[1]));
      // The Article comes from a model: the preview may not run scripts wherever it is opened.
      return rendered
        ? new Response(rendered.html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "sandbox; default-src 'none'; img-src https:; style-src 'unsafe-inline'" } })
        : json({ error: "Article not found" }, 404);
    }

    const setting = pathname.match(/^\/api\/settings\/([\w-]+)$/);
    if (setting && req.method === "PUT") {
      const body = (await req.json().catch(() => null)) as { value?: unknown } | null;
      if (typeof body?.value !== "string") return json({ error: "Invalid value" }, 400);
      if (!isSettingKey(setting[1]!)) return json({ error: "Unknown setting" }, 404);
      const invalid = await validateSettings({ [setting[1]]: body.value });
      if (invalid) return invalid;
      settings.set(setting[1], body.value);
      return json(settings.all());
    }

    if (pathname === "/api/events" && req.method === "GET") {
      const encoder = new TextEncoder();
      const frame = (event: string, data: unknown) => encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      let unsubscribe: (() => void)[] = [];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(": connected\n\n"));
          const send = (event: string) => (data: unknown) => controller.enqueue(frame(event, data));
          unsubscribe = [
            pipeline.subscribe(send("video")),
            pipeline.subscribeChunks(send("article_chunk")),
            pipeline.subscribeLogs(send("log")),
            channels.subscribe((e) => (e.type === "changed" ? send("channel")(e.channel) : send("channel_removed")({ id: e.id }))),
          ];
        },
        cancel: () => unsubscribe.forEach((off) => off()),
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    return json({ error: "Not found" }, 404);
  }

  return {
    fetch,
    /** Resumes whatever the database says is waiting. */
    start: () => {
      pipeline.recover();
      pipeline.pump();
      void detection.tick();
    },
    stop: () => {
      detection.stop();
      db.close();
    },
  };
}
