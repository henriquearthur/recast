import { modelSetting, type GenerationProvider } from "./generation";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export const DEFAULT_GLOBAL_PROMPT = `You turn the transcript of a YouTube video into an article to read instead of watching.

Write in Markdown, with this structure and in this order:

## TL;DR
A summary of 3 to 5 bullet points with the essentials of the video. Someone who reads only this part should come away knowing the conclusion.

## (one section for each topic of the video)
The body of the article, in the order of the video. Each section has its own heading (##) saying what it covers, ending with the moment the topic starts, copied from the transcript, in square brackets. Example: "## Why the price went up [12:34]". Write in paragraphs; use lists only for enumerations, **bold** for numbers and key terms, and > for a literal quote.

## Key takeaways
2 to 4 bullet points with the practical conclusions, recommendations, or next steps given in the video. Leave this section out if the video has none.

Keep the "TL;DR" heading as is and write every other heading in the language of the article.
Do not write the article title (#) or the video details (channel, date, duration, link): Recast already shows all of that above the text.
Write in the voice of the person speaking in the video, in the first person, as if they had written the article themselves: "I think", "in my opinion", "we tested". Never refer to them in the third person ("he says", "the author explains", "in her opinion", "the video shows"). If more than one person speaks, the first person is the channel owner and the others are quoted by name.
Be faithful to the content: do not make up facts and do not comment on the video; just write the article.`;

/** SHA-256 of the defaults of earlier versions: a stored Global Prompt equal to one of them was never customized, so it follows the current default. */
const SUPERSEDED_GLOBAL_PROMPTS = new Set([
  "6616fcbd06feda37ddb3d440ab18ba380be64751ecf449017349864caccd529a",
  "5e1ade293b51938ae5b7ebf08dd8fedb7a61e83bd5aedbcabc1612f26ee58a74",
  "c3944c0b553d20a645ed4f6d21a9e2b0219cb644f7c6f3ba9c0609ae9d31c566",
]);

/** The settings Recast knows; anything else is refused. */
export const SETTING_KEYS = ["globalPrompt", "articleLanguage", "model", "recipient", "provider", "copilotModel", "claudeModel", "codexModel"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export const isSettingKey = (key: string): key is SettingKey => (SETTING_KEYS as readonly string[]).includes(key);

/** Defaults of the settings that have one. Settings are stored as plain key/value text. */
export const SETTING_DEFAULTS: Partial<Record<SettingKey, string>> = {
  globalPrompt: DEFAULT_GLOBAL_PROMPT,
  /** Language code (BCP 47) Articles are written in, whatever the language of the Video. */
  articleLanguage: "en",
  model: "gpt-6-luna",
  provider: "copilot",
  claudeModel: "",
  codexModel: "",
};

/** Generic key/value settings stored in SQLite; keys with a default (above) read as that default until changed. */
export class Settings {
  constructor(private db: Database) {
    const stored = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'globalPrompt'").get()?.value;
    if (stored !== undefined && SUPERSEDED_GLOBAL_PROMPTS.has(createHash("sha256").update(stored).digest("hex")))
      db.run("DELETE FROM settings WHERE key = 'globalPrompt'");
  }

  generationModel(provider: GenerationProvider): string {
    return this.get(modelSetting(provider)) ?? (provider === "copilot" ? this.get("model")! : "");
  }

  get(key: SettingKey): string | null {
    const row = this.db.query<{ value: string }, [string]>("SELECT value FROM settings WHERE key = ?").get(key);
    return row?.value ?? SETTING_DEFAULTS[key] ?? null;
  }

  set(key: SettingKey, value: string) {
    if (key === "model") this.set("copilotModel", value);
    this.db.query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  all(): Record<string, string> {
    const stored = this.db.query<{ key: string; value: string }, []>("SELECT key, value FROM settings").all();
    return { ...SETTING_DEFAULTS, ...Object.fromEntries(stored.map((r) => [r.key, r.value])), copilotModel: this.generationModel("copilot") };
  }
}
