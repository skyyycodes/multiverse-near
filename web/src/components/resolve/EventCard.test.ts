import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventState } from "@/lib/domain";
import { EventCard } from "./EventCard";

const resolved: EventState = {
  id: 3,
  question: "Did the Fed cut at its October 27-28, 2026 meeting?",
  rule: "r",
  outcomeNames: ["CUTS", "HOLDS"],
  deadline: 0n,
  proposedAt: 1_794_340_800n,
  proposedOutcome: 1,
  proposalOpen: false,
  finalized: true,
  outcome: 1,
  finalizableAt: 0n,
  proposedBy: "reporter",
};

const html = (inGrid?: boolean) => renderToStaticMarkup(createElement(EventCard, { event: resolved, windowSec: 30, inGrid }));

describe("a resolved event's status line", () => {
  it("says the other worlds are gone for an event of the grid", () => {
    expect(html()).toContain("Resolved <span class=\"font-semibold\">HOLDS</span> by the resolver. Worlds without it are gone for good.");
  });

  it("says nothing about worlds for an event outside the grid", () => {
    const out = html(false);
    expect(out).toContain("by the resolver.");
    expect(out).not.toContain("Worlds without it");
  });
});
