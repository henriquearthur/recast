import { languageName } from "../../i18n";
import { t, translateMessage, getLocale } from "../lib/i18n";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { GENERATION_PROVIDERS, modelSetting, providerName, type GenerationProvider, type ModelCatalog, type ProviderStatus } from "../../server/generation";
import { PageHeader, Panel } from "../components/recast";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Textarea } from "../components/ui/textarea";
import { api } from "../lib/live";

const FIELDS = ["provider", "copilotModel", "claudeModel", "codexModel", "recipient", "articleLanguage", "globalPrompt"] as const;
const LANGUAGES = ["en", "pt-BR", "es", "fr", "de", "it", "ja", "zh"];
const timestamp = (at: number) => new Date(at).toLocaleString(getLocale());

export function SettingsPage() {
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [saved, setSaved] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<ProviderStatus[]>([]);
  const [catalogs, setCatalogs] = useState<Partial<Record<GenerationProvider, ModelCatalog>>>({});
  const [loading, setLoading] = useState<GenerationProvider | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = (values?.provider ?? "copilot") as GenerationProvider;
  const loadStatuses = () => api.get<ProviderStatus[]>("/api/providers").then(setStatuses);
  useEffect(() => {
    void Promise.all([api.get<Record<string, string>>("/api/settings"), loadStatuses()]).then(([s]) => {
      setValues({ recipient: "", ...s }); setSaved({ recipient: "", ...s });
    }).catch((error) => setError(error.message));
    const timer = setInterval(() => { void loadStatuses().catch(() => {}); }, 30_000);
    return () => clearInterval(timer);
  }, []);
  async function loadModels(provider: GenerationProvider, refresh = false) {
    setLoading(provider);
    try {
      const catalog = refresh ? await api.send<ModelCatalog>("POST", `/api/providers/${provider}/models`, {}) : await api.get<ModelCatalog>(`/api/providers/${provider}/models`);
      setCatalogs((all) => ({ ...all, [provider]: catalog }));
      void loadStatuses().catch(() => {});
    } catch (error) { toast.error(translateMessage((error as Error).message)); }
    finally { setLoading((current) => current === provider ? null : current); }
  }
  useEffect(() => { if (values) void loadModels(selected); }, [values !== null, selected]);
  if (error) return <Panel className="p-6"><p role="alert">{translateMessage(error)}</p></Panel>;
  if (!values) return <Skeleton className="h-96 rounded-2xl" />;
  const field = (key: string) => ({ id: key, value: values[key] ?? "", onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setValues({ ...values, [key]: e.target.value }) });
  const dirty = FIELDS.some((key) => values[key] !== saved[key]);
  const catalog = catalogs[selected];
  const modelKey = modelSetting(selected);
  const model = values[modelKey] ?? "";
  const missingModel = model && !catalog?.models.some((m) => m.id === model);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true);
    try {
      const changed = Object.fromEntries(FIELDS.filter((key) => values![key] !== saved[key]).map((key) => [key, values![key] ?? ""]));
      const result = await api.send<Record<string, string>>("PUT", "/api/settings", changed);
      setValues({ recipient: "", ...result }); setSaved({ recipient: "", ...result });
      toast.success(t("Settings saved"));
    } catch (err) { toast.error(translateMessage((err as Error).message)); }
    finally { setSaving(false); }
  }
  const stateLabel = { unconfigured: t("Not configured"), configured: t("Configured"), authenticated: t("Authenticated"), error: t("Could not verify") };
  return (
    <form onSubmit={save}>
      <PageHeader title={t("Settings")} description={t("Where articles go and how they are written.")}>
        <Button disabled={!dirty || saving}>{saving ? t("Saving…") : t("Save settings")}</Button>
      </PageHeader>
      <div className="grid max-w-4xl gap-5">
        <Panel className="rise space-y-5 p-6">
          <fieldset className="space-y-3">
            <legend className="mb-3 text-sm font-semibold">{t("Generation provider")}</legend>
            <div className="grid gap-3 sm:grid-cols-3">
              {GENERATION_PROVIDERS.map((provider) => {
                const status = statuses.find((s) => s.provider === provider);
                const last = status?.lastGeneration;
                return <label key={provider} className={`cursor-pointer rounded-xl border p-4 ${selected === provider ? "border-foreground bg-marker-soft" : "bg-card"}`}>
                  <span className="flex items-center gap-2 text-sm font-semibold"><input type="radio" name="provider" value={provider} checked={selected === provider} onChange={() => setValues({ ...values, provider })} />{providerName[provider]}</span>
                  <span className="mt-3 block text-xs font-medium">{status ? stateLabel[status.state] : t("Checking…")}{status?.authMethod ? ` · ${status.authMethod}` : ""}</span>
                  {status?.detail && <span className="mt-2 block text-xs text-muted-foreground">{translateMessage(status.detail)}</span>}
                  <span className="mt-3 block text-xs text-muted-foreground">{!last ? t("Not used yet") : last.status === "done" ? t("Last generation completed") : last.status === "cancelled" ? t("Last generation cancelled") : t("Last generation failed")}</span>
                  {last && <><span className="mt-1 block text-xs text-muted-foreground">{timestamp(last.at)} · {last.model}</span>{last.error && <span className="mt-1 block break-words text-xs text-critical">{translateMessage(last.error)}</span>}</>}
                </label>;
              })}
            </div>
          </fieldset>
          <p className="text-xs text-muted-foreground">{t("Authentication is configured on the server. Operation is only confirmed by an actual generation.")}</p>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="generation-model">{t("Model")}</Label>
              <Button type="button" variant="outline" size="sm" disabled={loading === selected} onClick={() => void loadModels(selected, true)}>{loading === selected ? t("Updating…") : t("Refresh models")}</Button>
            </div>
            <select id="generation-model" value={model} disabled={!catalog?.models.length || loading === selected} onChange={(e) => setValues({ ...values, [modelKey]: e.target.value })} className="h-10 w-full rounded-md border bg-card px-3 text-sm">
              <option value="">{t("Select a model")}</option>
              {missingModel && <option value={model} disabled>{model} · {t("outside the latest catalog")}</option>}
              {catalog?.models.map((m) => <option key={m.id} value={m.id}>{m.name} · {m.id}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{t("One model saved per provider, also used for regenerations.")}</p>
            {catalog?.updatedAt && <p className="text-xs text-muted-foreground">{t("Catalog fetched online on {0}", timestamp(catalog.updatedAt))}</p>}
            {catalog?.error && <p role="alert" className="text-xs text-critical">{translateMessage(catalog.error)} {catalog.models.length > 0 ? t("Showing the last saved catalog.") : t("No saved catalog. Refresh models after configuring the provider.")}</p>}
          </div>
        </Panel>
        <Panel className="rise space-y-2 p-6">
          <Label htmlFor="recipient">{t("Email recipient")}</Label>
          <Input {...field("recipient")} type="email" placeholder={t("you@example.com")} className="bg-card" />
          <p className="text-xs text-muted-foreground">{t("Each finished article is sent to this address.")}</p>
        </Panel>
        <Panel className="rise space-y-2 p-6">
          <Label htmlFor="articleLanguage">{t("Article language")}</Label>
          <Input {...field("articleLanguage")} list="article-languages" required className="bg-card" />
          <datalist id="article-languages">{LANGUAGES.map((code) => <option key={code} value={code}>{languageName(code, getLocale())}</option>)}</datalist>
          <p className="text-xs text-muted-foreground">{t("Language code (BCP 47) the articles and emails are written in, whatever the language of the video.")}</p>
        </Panel>
        <Panel className="rise space-y-2 p-6">
          <Label htmlFor="globalPrompt">{t("Global Prompt")}</Label>
          <p className="text-xs text-muted-foreground">{t("Instructions defining the format of every article. Each channel's instructions complement this text.")}</p>
          <Textarea {...field("globalPrompt")} rows={18} className="bg-card font-mono text-[0.8125rem] leading-relaxed" />
          <p className="text-xs text-muted-foreground">{t("The email and article page highlight the section")} <code className="font-mono">## TL;DR</code> {t("and link headings ending in a timestamp to the video, such as")} <code className="font-mono">[12:34]</code>.</p>
        </Panel>
      </div>
    </form>
  );
}
