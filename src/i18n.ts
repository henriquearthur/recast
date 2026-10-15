import portuguese from "./locales/pt-BR.json";

/** Languages of the interface and of e-mails. English messages in the code are the source; other locales translate them. */
export type Locale = "en" | "pt-BR";
const catalogs: Record<Locale, Record<string, string>> = { en: {}, "pt-BR": portuguese };

/** The interface locale closest to a language code (BCP 47), English when there is no translation. */
export const localeFor = (language: string | null | undefined): Locale => language?.toLowerCase().startsWith("pt") ? "pt-BR" : "en";

/** Translates an English source message into `locale`, filling `{0}`, `{1}`… with `values`. */
export function translate(locale: Locale, message: string, ...values: unknown[]): string {
  const catalog = catalogs[locale];
  const template = Object.hasOwn(catalog, message) ? catalog[message]! : message;
  return template.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ""));
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const patterns = Object.keys(portuguese).filter((key) => /\{\d+\}/.test(key)).map((key) => ({
  key,
  regex: new RegExp(`^${key.split(/\{\d+\}/).map(escape).join("(.*?)")}$`, "s"),
}));

/** Translates application-owned status/error text from the API, including nested messages; external diagnostics stay intact. */
export function translateMessage(locale: Locale, message: string): string {
  const catalog = catalogs[locale];
  if (locale === "en" || Object.hasOwn(catalog, message)) return translate(locale, message);
  for (const { key, regex } of patterns) {
    const match = message.match(regex);
    if (match) {
      const values = match.slice(1).map((value) => translateMessage(locale, value));
      if (key === "elapsed {0} · {1}x audio speed") values[1] = values[1]!.replace(".", ",");
      return translate(locale, key, ...values);
    }
  }
  return message;
}

/** The name of a language code (BCP 47) in `locale`, e.g. "Brazilian Portuguese" or "inglês"; the code itself when unknown. */
export function languageName(code: string, locale: Locale = "en"): string {
  try {
    const name = new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    return locale === "pt-BR" ? name.toLowerCase() : name;
  } catch {
    return code;
  }
}
