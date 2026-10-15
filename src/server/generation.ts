/** Product vocabulary shared by the API and UI; SDKs stay server-side. */
export const GENERATION_PROVIDERS = ["copilot", "claude", "codex"] as const;
export type GenerationProvider = (typeof GENERATION_PROVIDERS)[number];
export const providerName: Record<GenerationProvider, string> = { copilot: "GitHub Copilot", claude: "Claude Agent", codex: "OpenAI · Codex" };
export const isGenerationProvider = (value: string): value is GenerationProvider => GENERATION_PROVIDERS.includes(value as GenerationProvider);
export const modelSetting = (provider: GenerationProvider) => `${provider}Model` as const;
export interface GenerationModel {
  id: string;
  name: string;
  contextWindow?: number;
}
export interface ModelCatalog {
  models: GenerationModel[];
  updatedAt: number | null;
  error: string | null;
}
export interface ProviderStatus {
  provider: GenerationProvider;
  state: "unconfigured" | "configured" | "authenticated" | "error";
  authMethod: string | null;
  detail: string | null;
  checkedAt: number;
  catalog: ModelCatalog;
  lastGeneration: { status: string; at: number; model: string; error: string | null } | null;
}
