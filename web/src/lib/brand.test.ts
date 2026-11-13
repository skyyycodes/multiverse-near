// WI-7: every brand string lives in BRAND. This scans the app's sources so a hard-coded name, tagline or the old
// product name fails here instead of shipping.
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

/** Sources the rule applies to: everything but the constant itself, the design fixtures and the tests. */
const SCANNED = sources(SRC)
  .map((p) => relative(SRC, p).split(sep).join("/"))
  .filter((p) => p !== "lib/brand.ts" && !p.startsWith("lib/fixtures/") && !/\.test\.tsx?$/.test(p));

/** Code without its comments: what a user can see is in string literals and JSX text, never in a comment. */
function code(path: string): string {
  return readFileSync(join(SRC, path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");
}

const OLD = /Multiverse Lending|In Multiverse|Multiverse contract|with Multiverse/;
/** "Multiverse" as a name, not an id ("multiverse-demo", "multiverse.welcomed") or part of a longer identifier. */
const CAPITALISED = /(?<![\w-])Multiverse(?![\w.-])/;

describe("the brand constant", () => {
  it("holds the owner's strings exactly (DECISIONS 2026-11-13)", () => {
    expect(BRAND.name).toBe("IfVerse");
    expect(BRAND.slug).toBe("ifverse");
    expect(BRAND.formerly).toBe("formerly Multiverse Lending");
    expect(BRAND.headline).toBe("What if your what-ifs became worlds?");
    expect(BRAND.subline).toBe("A multiverse for the real world.");
    expect(BRAND.explainer).toBe("Hold NEAR in the futures you like and dollars in the ones you fear.");
    expect(BRAND.short).toBe("Every what-if gets its own world.");
    expect(BRAND.innerBalance).toBe("In IfVerse");
    expect(BRAND.credit).toEqual({
      text: "The idea of splitting assets into verses comes from Paradigm's Multiverse Finance essay (Dave White, May 2025)",
      url: "https://www.paradigm.xyz/2025/05/multiverse-finance",
    });
    expect(BRAND.testnetNote).toBe("Runs on NEAR testnet. Test tokens have no value.");
  });

  it("finds the sources it scans", () => {
    expect(SCANNED.length).toBeGreaterThan(50);
    expect(SCANNED).toContain("app/layout.tsx");
    expect(SCANNED).toContain("components/shell/TopBar.tsx");
  });

  it("leaves no old product name in any source", () => {
    const hits = SCANNED.filter((p) => OLD.test(code(p)) || CAPITALISED.test(code(p)));
    expect(hits).toEqual([]);
  });

  it("keeps every brand string inside BRAND", () => {
    const strings = [BRAND.name, BRAND.headline, BRAND.subline, BRAND.explainer, BRAND.short, BRAND.innerBalance, BRAND.testnetNote, BRAND.credit.text];
    const hits = SCANNED.flatMap((p) => strings.filter((s) => code(p).includes(s)).map((s) => `${p}: ${s}`));
    expect(hits).toEqual([]);
  });

  it("names the page from the constant", () => {
    const layout = code("app/layout.tsx");
    expect(layout).toContain("title: BRAND.name");
    expect(layout).toContain("description: BRAND.short");
  });

  it("catches what it is meant to catch", () => {
    expect(OLD.test('label="In Multiverse"')).toBe(true);
    expect(CAPITALISED.test("<span>Multiverse</span>")).toBe(true);
    expect(CAPITALISED.test('"Multiverse"')).toBe(true);
    expect(CAPITALISED.test('const id = "multiverse-demo";')).toBe(false);
    expect(CAPITALISED.test("standard: \"multiverse\"")).toBe(false);
    expect(code("lib/data/client.ts")).not.toContain("/**");
  });
});
