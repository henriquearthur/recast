import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
// index.html reads the same key before the first paint, so the page never flashes the wrong theme.
const STORAGE_KEY = "recast.theme";
const THEME_COLOR: Record<Theme, string> = { light: "#f4f5f0", dark: "#0f120d" };
const listeners = new Set<() => void>();

export function detectTheme(saved: string | null, prefersDark: boolean): Theme {
  if (saved === "light" || saved === "dark") return saved;
  return prefersDark ? "dark" : "light";
}

function initialTheme(): Theme {
  let saved: string | null = null;
  try { saved = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null; } catch {}
  return detectTheme(saved, globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);
}

function apply(next: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", next === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[next]);
}

let theme = initialTheme();
apply(theme);
export const getTheme = () => theme;

export function setTheme(next: Theme) {
  theme = next;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, next); } catch {}
  apply(next);
  listeners.forEach((listener) => listener());
}

export function useTheme(): [Theme, typeof setTheme] {
  const value = useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, getTheme);
  return [value, setTheme];
}
