import { useSyncExternalStore } from "react";
import { translate, translateMessage as translateIn, type Locale } from "../../i18n";

export type { Locale };
const STORAGE_KEY = "recast.locale";
const listeners = new Set<() => void>();

export function detectLocale(saved: string | null, languages: readonly string[]): Locale {
  if (saved === "en" || saved === "pt-BR") return saved;
  return languages[0]?.toLowerCase().startsWith("pt") ? "pt-BR" : "en";
}

function initialLocale(): Locale {
  let saved: string | null = null;
  try { saved = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null; } catch {}
  return detectLocale(saved, globalThis.navigator?.languages ?? []);
}

let locale = initialLocale();
export const getLocale = () => locale;

export function setLocale(next: Locale) {
  locale = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch {}
  if (typeof document !== "undefined") document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

export function useLocale(): [Locale, typeof setLocale] {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getLocale);
  return [value, setLocale];
}

/** English source messages are translated into the selected interface language. */
export const t = (message: string, ...values: unknown[]) => translate(locale, message, ...values);

/** Translate application-owned status/error text from the API; keep external diagnostics intact. */
export const translateMessage = (message: string) => translateIn(locale, message);
