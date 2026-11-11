// Signing side of the resolver: the real sources and the reporter's function-call key.

import { readFile } from "node:fs/promises";

import { chainNowSec } from "./chain.ts";
import { fomcOutcome } from "./fred.ts";
import { call } from "./near.ts";
import type { Protocol } from "./protocol.ts";
import type { ResolverDeps } from "./resolver.ts";
import { tgas } from "./units.ts";

const REPORT_KEY = "report";

export function reporterDeps(p: Protocol, outcomesPath: string): ResolverDeps {
  const reporter = p.d.reporter;
  return {
    getEvent: (id) => p.event(id),
    nowSec: chainNowSec,
    fomcOutcome: (before, after) => fomcOutcome(before, after),
    teamFile: async () => JSON.parse(await readFile(outcomesPath, "utf8")) as unknown,
    report: async (eventId, outcome, evidence) => {
      await call(reporter, p.contract, "report_outcome", { event_id: eventId, outcome, target: p.contract, evidence }, {
        keyVariant: REPORT_KEY,
        gas: tgas(50),
        label: `${reporter}: report_outcome(${eventId}, ${outcome})`,
      });
    },
    finalize: async (eventId) => {
      await call(reporter, p.contract, "finalize", { event_id: eventId }, {
        keyVariant: REPORT_KEY,
        gas: tgas(100),
        label: `${reporter}: finalize(${eventId})`,
      });
    },
    log: (line) => console.log(`  ${line}`),
  };
}

