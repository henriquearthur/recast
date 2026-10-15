import { describe, expect, test } from "bun:test";
import { detectTheme } from "../src/web/lib/theme";

describe("interface theme", () => {
  test("a saved choice takes priority, otherwise the system preference decides", () => {
    expect(detectTheme("light", true)).toBe("light");
    expect(detectTheme("dark", false)).toBe("dark");
    expect(detectTheme(null, true)).toBe("dark");
    expect(detectTheme(null, false)).toBe("light");
    expect(detectTheme("invalid", true)).toBe("dark");
  });
});
