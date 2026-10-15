import { t, translateMessage, useLocale } from "./lib/i18n";
import { AlertTriangle, BookOpenText, ChartColumn, CircleDollarSign, Clapperboard, House, Moon, Radio, Settings, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HealthReport } from "../server/health";
import { Logo } from "./components/recast";
import { Toaster } from "./components/ui/sonner";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip";
import { api, useChannels, useCosts, useStats, useVideos } from "./lib/live";
import { useTheme } from "./lib/theme";
import { cn } from "./lib/utils";
import { ChannelsPage } from "./pages/Channels";
import { CostsPage } from "./pages/Costs";
import { HomePage } from "./pages/Home";
import { ArticlesPage, VideosPage } from "./pages/Lists";
import { SettingsPage } from "./pages/Settings";
import { StatsPage } from "./pages/Stats";
import { VideoPage } from "./pages/Video";

const NAV = [
  ["#/", "Home", House],
  ["#/articles", "Articles", BookOpenText],
  ["#/videos", "Videos", Clapperboard],
  ["#/channels", "Channels", Radio],
  ["#/stats", "Stats", ChartColumn],
  ["#/costs", "Costs", CircleDollarSign],
] as const;

function useHash() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return hash;
}

function useHealth() {
  const [report, setReport] = useState<HealthReport | null>(null);
  useEffect(() => {
    const load = () => api.get<HealthReport>("/api/health").then(setReport, () => {});
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);
  return report;
}

/** Warns, on every screen, about what the service is missing to work. */
function HealthBanner({ report }: { report: HealthReport | null }) {
  if (!report || report.ok) return null;
  return (
    <div role="alert" className="mb-6 flex gap-3 rounded-2xl border border-danger-border bg-danger-soft p-5 text-danger-foreground">
      <AlertTriangle className="mt-0.5 size-5 shrink-0" />
      <div>
        <p className="font-semibold">{t("Recast cannot process videos: configuration is missing for")} {report.problems.length === 1 ? t("one item") : t("{0} items", report.problems.length)}.</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
          {report.problems.map((p, index) => (
            <li key={`${p.key}-${index}`}>{translateMessage(p.message)}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function App() {
  const [locale, setLocale] = useLocale();
  const [theme, setTheme] = useTheme();
  useEffect(() => { document.documentElement.lang = locale; }, [locale]);
  const videos = useVideos();
  const { channels, reload } = useChannels();
  const stats = useStats(videos);
  const costs = useCosts(videos);
  const health = useHealth();
  const hash = useHash();
  const id = hash.match(/^#\/videos\/(\d+)$/)?.[1];
  const section = id ? "#/videos" : hash;
  const busy = (videos ?? []).filter((v) => v.state === "in_progress").length;
  return (
    <TooltipProvider delayDuration={150}>
      <header className="sticky top-0 z-40 border-b bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[76rem] items-center gap-2 px-4 sm:gap-4 sm:px-6">
          <a href="#/" className="flex items-center gap-2.5" aria-label={t("Recast, home")}>
            <Logo />
            <span className="font-display text-xl font-bold tracking-tight">Recast</span>
          </a>
          <nav className="hidden items-center gap-1 md:flex" aria-label={t("Main navigation")}>
            {NAV.map(([href, label]) => (
              <a
                key={href}
                href={href}
                aria-current={section === href ? "page" : undefined}
                className={cn("rounded-full px-3.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground", section === href && "bg-foreground text-primary-foreground hover:text-primary-foreground")}
              >
                {t(label)}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <select aria-label={t("Interface language")} value={locale} onChange={(event) => setLocale(event.target.value as "en" | "pt-BR")} className="h-9 rounded-full border bg-card px-2 text-xs">
              <option value="en">English</option>
              <option value="pt-BR">Português (BR)</option>
            </select>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")} aria-label={theme === "dark" ? t("Switch to light mode") : t("Switch to dark mode")} className="grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground">
                  {theme === "dark" ? <Sun className="size-[1.125rem]" /> : <Moon className="size-[1.125rem]" />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{theme === "dark" ? t("Switch to light mode") : t("Switch to dark mode")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <a href={health && !health.ok ? "#/" : "#/videos"} className="hidden items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs font-medium lg:flex">
                  <span className={cn("size-2 rounded-full", health && !health.ok ? "bg-critical" : busy ? "animate-pulse bg-marker ring-1 ring-foreground/30" : "bg-good")} />
                  {health && !health.ok ? t("Needs attention") : busy ? t("{0} in progress", busy) : t("All caught up")}
                </a>
              </TooltipTrigger>
              <TooltipContent>{health && !health.ok ? t("Recast needs configuration before it can process videos.") : busy ? t("Videos are being processed now.") : t("No videos in the queue.")}</TooltipContent>
            </Tooltip>
            <a href="#/settings" aria-label={t("Settings")} aria-current={hash === "#/settings" ? "page" : undefined} className={cn("grid size-9 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground", hash === "#/settings" && "bg-foreground text-primary-foreground hover:bg-foreground hover:text-primary-foreground")}>
              <Settings className="size-[1.125rem]" />
            </a>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[76rem] px-4 pt-8 pb-28 sm:px-6 md:pb-16">
        <HealthBanner report={health} />
        {hash === "#/articles" ? (
          <ArticlesPage videos={videos} channels={channels ?? []} />
        ) : hash === "#/videos" ? (
          <VideosPage videos={videos} channels={channels ?? []} />
        ) : hash === "#/channels" ? (
          <ChannelsPage channels={channels} reload={reload} stats={stats} />
        ) : hash === "#/stats" ? (
          <StatsPage stats={stats} videos={videos} />
        ) : hash === "#/costs" ? (
          <CostsPage costs={costs} stats={stats} />
        ) : hash === "#/settings" ? (
          <SettingsPage />
        ) : id ? (
          <VideoPage key={id} video={videos?.find((v) => v.id === Number(id))} loading={videos === null} />
        ) : (
          <HomePage videos={videos} channels={channels} stats={stats} />
        )}
      </main>
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden" aria-label={t("Main navigation")}>
        {NAV.map(([href, label, Icon]) => (
          <a key={href} href={href} aria-current={section === href ? "page" : undefined} className={cn("flex flex-col items-center gap-1 py-2.5 text-[0.6875rem] font-medium text-muted-foreground", section === href && "text-foreground")}>
            <span className={cn("grid h-7 w-12 place-items-center rounded-full", section === href && "bg-marker text-ink")}>
              <Icon className="size-[1.125rem]" />
            </span>
            {t(label)}
          </a>
        ))}
      </nav>
      <Toaster position="bottom-center" theme={theme} />
    </TooltipProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
