// Which story stage and persona the design fixtures show. Read from the URL (?fx=sold&as=alice) and kept for the tab,
// so in-app navigation stays on the same stage.
import { PERSONAS, STAGES, type Persona, type Stage } from "./golden";

const STAGE_KEY = "multiverse.fixtures.stage";
const PERSONA_KEY = "multiverse.fixtures.as";

function read(param: string, key: string): string | null {
  if (typeof window === "undefined") return null;
  const fromUrl = new URLSearchParams(window.location.search).get(param);
  try {
    if (fromUrl !== null) sessionStorage.setItem(key, fromUrl);
    return fromUrl ?? sessionStorage.getItem(key);
  } catch {
    return fromUrl;
  }
}

export function fixtureStage(): Stage {
  const s = read("fx", STAGE_KEY);
  return (STAGES as readonly string[]).includes(s ?? "") ? (s as Stage) : "seeded";
}

export function setFixtureStage(stage: Stage) {
  try {
    sessionStorage.setItem(STAGE_KEY, stage);
  } catch {
    // private mode: the stage simply resets on reload
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has("fx")) {
    url.searchParams.set("fx", stage);
    window.history.replaceState(null, "", url);
  }
}

/** The persona the fixture wallet starts connected as; null starts disconnected. */
export function fixturePersona(): Persona | null {
  const p = read("as", PERSONA_KEY);
  return (PERSONAS as readonly string[]).includes(p ?? "") ? (p as Persona) : null;
}

export function setFixturePersona(p: Persona | null) {
  try {
    if (p) sessionStorage.setItem(PERSONA_KEY, p);
    else sessionStorage.setItem(PERSONA_KEY, "none");
  } catch {
    // ignore
  }
}
