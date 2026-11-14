// The site's name is IfVerse (DECISIONS 2026-11-14 12:10): every brand string lives in BRAND, and no source shows the
// redesign's working name or the old product name. Scans ui/src, comments left out (only code is ever on screen).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BRAND } from "./brand";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Sources the rule applies to: everything but the constant itself and the tests. */
const SCANNED = sources(SRC)
  .map((p) => relative(SRC, p).split(sep).join("/"))
  .filter((p) => p !== "chain/brand.ts" && !/\.test\.tsx?$/.test(p));

/** Code without its comments. */
function code(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

/** The redesign's working name and the old product name; "Multiverse Finance" (the paper) stays allowed. */
const OLD = /Origami|Multiverse Lending|In Multiverse|Multiverse contract|with Multiverse/;

describe("the brand", () => {
  it("is IfVerse", () => {
    expect(BRAND.name).toBe("IfVerse");
    expect(BRAND.slug).toBe("ifverse");
    expect(BRAND.short).toBe("Every what-if gets its own world.");
  });

  it("finds the sources it scans", () => {
    expect(SCANNED.length).toBeGreaterThan(80);
    expect(SCANNED).toContain("app/layout.tsx");
    expect(SCANNED).toContain("components/layout/Header.tsx");
  });

  it("leaves no old name in any source", () => {
    expect(SCANNED.filter((p) => OLD.test(code(p)))).toEqual([]);
  });

  it("names the page and the site from the constant", () => {
    expect(code("app/layout.tsx")).toContain("title: BRAND.name");
    expect(code("config.ts")).toContain("name: BRAND.name");
  });

  it("catches what it is meant to catch", () => {
    expect(OLD.test("<span>Origami Verse</span>")).toBe(true);
    expect(OLD.test('aria-label="How Origami works"')).toBe(true);
    expect(OLD.test("Paradigm's Multiverse Finance paper")).toBe(false);
  });
});
