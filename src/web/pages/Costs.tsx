import { providerName } from "../../server/generation";
import { t, getLocale } from "../lib/i18n";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip as ChartTooltip, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { Costs, CostTotals } from "../../server/costs";
import type { Stats } from "../../server/stats";
import { Empty, PageHeader, Panel, PanelHeader, Sparkline, StatTile } from "../components/recast";
import { Skeleton } from "../components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { compact, usd, dayKey, number, shortDate } from "../lib/format";

const DAY = 86_400_000;
const month = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleDateString(getLocale(), { month: "short", year: "2-digit" }).replace(". de ", " ").replace(".", "");

function Tip({ active, payload }: { active?: boolean; payload?: { payload: { label: string; costUsd: number | null; unknownCosts?: number; generations?: number } }[] }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold">{d.label}</p>
      <p className="font-mono tabular-nums">{usd(d.costUsd)}{d.unknownCosts ? ` · ${t("Partial")}` : ""}</p>
      {d.generations != null && <p className="mt-0.5 text-muted-foreground">{d.generations === 1 ? t("1 generation") : t("{0} generations", d.generations)}</p>}
    </div>
  );
}

function Spend({ data, interval }: { data: { label: string; costUsd: number | null; unknownCosts?: number; generations?: number }[]; interval: number }) {
  return (
    <div className="h-64 px-3 pb-3">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barCategoryGap="22%">
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: "var(--axis)" }} interval={interval} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickMargin={8} />
          <YAxis width={40} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "var(--muted-foreground)" }} tickFormatter={(v: number) => number(v, v > 0 && v < 0.01 ? 4 : v < 1 ? 3 : v < 10 ? 2 : 0)} />
          <ChartTooltip content={<Tip />} cursor={{ fill: "var(--cursor)" }} />
          <Bar dataKey="costUsd" fill="var(--chart-read)" radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** One bar per group, longest first, each with its value at the tip: estimated USD by group. */
function Ranking({ rows }: { rows: { key: string; name: string; t: CostTotals }[] }) {
  const max = Math.max(...rows.map((r) => (r.t.costUsd ?? 0)), 1e-9);
  return (
    <ul className="space-y-4 p-6 pt-5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate font-medium">{r.name}</span>
            <span className="shrink-0 font-mono text-[0.8125rem] tabular-nums">{usd(r.t.costUsd)}{r.t.unknownCosts > 0 && ` · ${t("Partial")}`}</span>
          </div>
          {r.t.costUsd !== null && <div className="mt-1.5 h-2.5 rounded-r bg-transparent">
            <div className="h-full min-w-1 rounded-r bg-(--chart-read)" style={{ width: `${((r.t.costUsd ?? 0) / max) * 100}%` }} />
          </div>}
          <p className="mt-1 text-xs text-muted-foreground">
            {r.t.generations === 1 ? t("1 generation") : t("{0} generations", number(r.t.generations))} · {usd(r.t.unknownCosts || r.t.costUsd === null ? null : r.t.costUsd / r.t.generations)} {t("per generation")} </p>
        </li>
      ))}
    </ul>
  );
}

function Detail({ label, rows }: { label: string; rows: { key: string; name: string; t: CostTotals }[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="pl-6">{label}</TableHead>
          <TableHead className="text-right">{t("Generations")}</TableHead>
          <TableHead className="text-right">{t("Input tokens")}</TableHead>
          <TableHead className="text-right">{t("Output tokens")}</TableHead>
          <TableHead className="pr-6 text-right">{t("Estimated USD")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.key}>
            <TableCell className="pl-6 font-medium">{r.name}</TableCell>
            <TableCell className="text-right font-mono text-[0.8125rem] tabular-nums">{number(r.t.generations)}</TableCell>
            <TableCell className="text-right font-mono text-[0.8125rem] tabular-nums">{r.t.unknownUsage === r.t.generations ? t("Unavailable") : number(r.t.inputTokens)}</TableCell>
            <TableCell className="text-right font-mono text-[0.8125rem] tabular-nums">{r.t.unknownUsage === r.t.generations ? t("Unavailable") : number(r.t.outputTokens)}</TableCell>
            <TableCell className="pr-6 text-right font-mono text-[0.8125rem] tabular-nums">{usd(r.t.costUsd)}{r.t.unknownCosts > 0 && <span className="ml-1 text-xs text-muted-foreground">{t("Partial")}</span>}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function CostsPage({ costs, stats }: { costs: Costs | null; stats: Stats | null }) {
  const [range, setRange] = useState("days");
  if (!costs || !stats) return <Skeleton className="h-96 rounded-2xl" />;
  const { total } = costs;
  const header = <PageHeader title={t("Costs")} description={t("Usage and estimated cost of writing articles. Includes regenerations and attempts with usage.")} />;
  if (total.generations === 0)
    return (
      <>
        {header}
        <Empty title={t("No usage yet")}>{t("Usage appears here once the first article has been written.")}</Empty>
      </>
    );
  const byDay = new Map(costs.byDay.map((d) => [d.day, d]));
  const today = new Date().setHours(12, 0, 0, 0);
  const days = Array.from({ length: 30 }, (_, i) => {
    const at = today - (29 - i) * DAY;
    const cost = byDay.get(dayKey(at));
    return { label: shortDate(at), costUsd: cost ? cost.costUsd : 0, unknownCosts: cost?.unknownCosts ?? 0 };
  });
  const months = costs.byMonth.map((m) => ({ label: month(m.month), costUsd: m.costUsd, unknownCosts: m.unknownCosts, generations: m.generations }));
  const byMonth = costs.byMonth.map(({ month: key, ...totals }) => ({ key, name: month(key), t: totals }));
  const byChannel = costs.byChannel.map(({ channelId, name, ...totals }) => ({ key: String(channelId), name: channelId === null ? t("Ad hoc videos") : (name ?? t("Channel {0}", channelId)), t: totals }));
  const byModel = costs.byModel.map(({ provider, model, ...totals }) => ({ key: `${provider}/${model}`, name: `${providerName[provider]} · ${model}`, t: totals }));
  const byProvider = costs.byProvider.map(({ provider, ...totals }) => ({ key: provider, name: providerName[provider], t: totals }));
  const tokens = total.inputTokens + total.outputTokens;
  const inputShare = (total.inputTokens / Math.max(tokens, 1)) * 100;
  const hours = stats.watchSeconds / 3600;
  return (
    <>
      {header}
      <div className="space-y-5">
        <p className="text-sm text-muted-foreground">{t("Copilot credits: {0}. Unknown values are not zero.", number(total.credits, 4))}{total.unknownUsage > 0 && ` ${t("{0} attempts without complete token information.", total.unknownUsage)}`}</p>
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label={t("Estimated cost")} value={usd(total.costUsd)} note={total.unknownCosts ? t("{0} generations with unavailable costs; partial total.", total.unknownCosts) : t("Estimates and equivalents; not an invoice.")}>
            {!total.unknownCosts && <Sparkline values={days.map((d) => d.costUsd ?? 0)} />}
          </StatTile>
          <StatTile label={t("Per article")} value={stats.articles && !total.unknownCosts && total.costUsd !== null ? usd(total.costUsd / stats.articles) : t("Unavailable")}  note={t("{0} {1}, including failed attempts", number(stats.articles), stats.articles === 1 ? t("finished article") : t("finished articles"))} />
          <StatTile label={t("Per hour of video")} value={hours >= 0.05 && !total.unknownCosts && total.costUsd !== null ? usd(total.costUsd / hours) : t("Unavailable")}  note={t("{0} h of video turned into text", number(hours, 1))} />
          <StatTile label={t("Tokens")} value={total.unknownUsage === total.generations ? t("Unavailable") : compact(tokens)} note={t("Most tokens are input: the full transcript is sent to the model.")}>
            {total.unknownUsage < total.generations && <div>
              <div className="flex h-2.5 gap-0.5">
                <div className="rounded-l bg-(--chart-read)" style={{ width: `${inputShare}%` }} />
                <div className="min-w-1 flex-1 rounded-r bg-(--chart-output)" />
              </div>
              <p className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-(--chart-read)" /> {t("Input")} {compact(total.inputTokens)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-sm bg-(--chart-output)" /> {t("Output")} {compact(total.outputTokens)}
                </span>
              </p>
            </div>}
          </StatTile>
        </div>
        <Panel className="rise">
          <Tabs value={range} onValueChange={setRange}>
            <PanelHeader title={t("Estimated cost over time")} hint={range === "days" ? t("Daily, over the last 30 days.") : t("Monthly, since the beginning.")}>
              <TabsList>
                <TabsTrigger value="days">{t("30 days")}</TabsTrigger>
                <TabsTrigger value="months">{t("Months")}</TabsTrigger>
              </TabsList>
            </PanelHeader>
            <TabsContent value="days" className="pt-4">
              <Spend data={days} interval={6} />
            </TabsContent>
            <TabsContent value="months" className="pt-4">
              <Spend data={months} interval={0} />
            </TabsContent>
          </Tabs>
        </Panel>
        <div className="grid gap-5 lg:grid-cols-2">
          <Panel className="rise">
            <PanelHeader title={t("By channel")} hint={t("Estimated USD by video source.")} />
            <Ranking rows={byChannel} />
          </Panel>
          <Panel className="rise">
            <PanelHeader title={t("By model")} hint={t("Estimated USD by provider and model.")} />
            <Ranking rows={byModel} />
          </Panel>
        </div>
        <Panel className="rise overflow-hidden"><PanelHeader title={t("By provider")} hint={t("Estimates and equivalents; not an invoice.")} /><Detail label={t("Provider")} rows={byProvider} /></Panel>
        <Panel className="rise overflow-hidden">
          <Tabs defaultValue="month">
            <PanelHeader title={t("Exact figures")} hint={t("The same chart data, in a table.")}>
              <TabsList>
                <TabsTrigger value="month">{t("Month")}</TabsTrigger>
                <TabsTrigger value="channel">{t("Channel")}</TabsTrigger>
                <TabsTrigger value="model">{t("Model")}</TabsTrigger>
              </TabsList>
            </PanelHeader>
            <TabsContent value="month" className="pt-4"><Detail label={t("Month")} rows={byMonth} /></TabsContent>
            <TabsContent value="channel" className="pt-4"><Detail label={t("Channel")} rows={byChannel} /></TabsContent>
            <TabsContent value="model" className="pt-4"><Detail label={t("Model")} rows={byModel} /></TabsContent>
          </Tabs>
        </Panel>
      </div>
    </>
  );
}
