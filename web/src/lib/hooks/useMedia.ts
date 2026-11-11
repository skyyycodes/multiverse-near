"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)";

function subscribe(fn: () => void) {
  const m = window.matchMedia(QUERY);
  m.addEventListener("change", fn);
  return () => m.removeEventListener("change", fn);
}

/**
 * The desktop layout (two columns) from 1024 px up. Decided in script rather than CSS so each screen renders one tree:
 * no hidden duplicate buttons for tests and the recorder to trip over. The app renders only in the browser.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}
