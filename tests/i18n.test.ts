import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import portuguese from "../src/locales/pt-BR.json";
import { languageName, localeFor } from "../src/i18n";
import { detectLocale, getLocale, setLocale, t, translateMessage } from "../src/web/lib/i18n";
import { compact, date, number, relative, shortDate, time } from "../src/web/lib/format";

const catalog: Record<string, string> = portuguese;
afterEach(() => setLocale("en"));

describe("interface language", () => {
  test("a saved preference takes priority, with browser detection and English fallback", () => {
    expect(detectLocale("en", ["pt-BR"])).toBe("en");
    expect(detectLocale("pt-BR", ["en-US"])).toBe("pt-BR");
    expect(detectLocale(null, ["pt-PT"])).toBe("pt-BR");
    expect(detectLocale("invalid", ["en-GB"])).toBe("en");
    expect(detectLocale(null, ["fr", "pt-BR"])).toBe("en");
    expect(detectLocale(null, [])).toBe("en");
  });

  test("switches labels and interpolated messages without changing values", () => {
    setLocale("pt-BR");
    expect(getLocale()).toBe("pt-BR");
    expect(t("Videos")).toBe("Vídeos");
    expect(t("Remove {0}?", "Science $& {1}")).toBe("Remover Science $& {1}?");
    setLocale("en");
    expect(t("Remove {0}?", "NASA")).toBe("Remove NASA?");
  });

  test("formats numbers, dates, times and relative timestamps with the selected locale", () => {
    const at = new Date(2026, 9, 7, 14, 30).getTime();
    for (const locale of ["en", "pt-BR"] as const) {
      setLocale(locale);
      expect(number(1234.5, 1)).toBe((1234.5).toLocaleString(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
      expect(compact(12000)).toBe((12000).toLocaleString(locale, { notation: "compact", maximumFractionDigits: 1 }));
      expect(date(at)).toBe(new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" }).replace(/\./g, "").replace(/ de /g, " "));
      expect(shortDate(at)).toBe(new Date(at).toLocaleDateString(locale, { day: "numeric", month: "short" }).replace(/\./g, "").replace(" de ", " "));
      expect(time(at)).toBe(new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }));
    }
    setLocale("en");
    expect(relative(at - 180_000, at)).toBe("3 min ago");
    expect(relative(at + 2 * 86_400_000, at)).toBe("in 2 days");
    setLocale("pt-BR");
    expect(relative(at - 180_000, at)).toBe("há 3 min");
    expect(relative(at + 86_400_000, at)).toBe("em 1 dia");
  });

  test("translates API diagnostics and nested errors while preserving paths and external text", () => {
    setLocale("pt-BR");
    expect(translateMessage("Invalid YouTube video URL")).toBe("URL de vídeo do YouTube inválida");
    expect(translateMessage("Transcription model not found: /home/example/model.bin. Set WHISPER_MODEL.")).toBe("Modelo de transcrição não encontrado: /home/example/model.bin. Defina WHISPER_MODEL.");
    expect(translateMessage("Could not look up the channel: Channel not found.")).toBe("Não foi possível consultar o canal: Canal não encontrado.");
    expect(translateMessage("toString")).toBe("toString");
    expect(translateMessage("External error {0}")).toBe("External error {0}");
    expect(translateMessage("ERROR: HTTP Error 429: Too Many Requests")).toBe("ERROR: HTTP Error 429: Too Many Requests");
    expect(translateMessage("elapsed 2:05 · 1.4x audio speed")).toBe("decorrido 2:05 · 1,4x o áudio");
    setLocale("en");
    expect(translateMessage("Invalid YouTube video URL")).toBe("Invalid YouTube video URL");
  });

  test("the e-mail locale follows the Article language, and languages are named in the reader's locale", () => {
    expect(localeFor("pt-BR")).toBe("pt-BR");
    expect(localeFor("pt")).toBe("pt-BR");
    expect(localeFor("es")).toBe("en");
    expect(localeFor(null)).toBe("en");
    expect(languageName("pt-BR")).toBe("Brazilian Portuguese");
    expect(languageName("en", "pt-BR")).toBe("inglês");
  });

  test("keeps every interpolation placeholder in the Portuguese catalog", () => {
    const placeholders = (text: string) => text.match(/\{\d+\}/g)?.sort() ?? [];
    for (const [source, translation] of Object.entries(catalog)) {
      expect(translation.trim().length).toBeGreaterThan(0);
      expect(placeholders(translation)).toEqual(placeholders(source));
    }
  });

  test("every literal interface message has a Portuguese catalog entry", () => {
    const web = join(import.meta.dir, "../src/web");
    function check(dir: string) {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) check(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          for (const match of source.matchAll(/\bt\(("(?:[^"\\]|\\.)*")/g)) {
            const key = JSON.parse(match[1]!);
            expect(catalog[key], `${path}: ${key}`).toBeDefined();
          }
        }
      }
    }
    check(web);
  });
});
