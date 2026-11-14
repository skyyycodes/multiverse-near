// The v2 form primitives rendered on the server (node env): what assistive tech and the recorder read from them.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChipScroller } from "./ChipScroller";
import { DateTimeField } from "./DateTimeField";
import { Disclosure } from "./Disclosure";
import { ProgressBar } from "./Progress";
import { SearchField } from "./SearchField";
import { TextArea, TextField } from "./TextField";

const noop = () => undefined;

describe("form primitives", () => {
  it("count UTF-8 bytes against the limit", () => {
    const ok = renderToStaticMarkup(createElement(TextField, { label: "Question", value: "Fédéral?", onChange: noop, maxBytes: 280, demo: "propose-question" }));
    expect(ok).toContain("10 / 280 bytes");
    expect(ok).toContain('data-demo="propose-question"');
    expect(ok).not.toContain("aria-invalid");
    const over = renderToStaticMarkup(createElement(TextArea, { label: "Rule", value: "€€", onChange: noop, maxBytes: 5 }));
    expect(over).toContain("6 / 5 bytes");
    expect(over).toContain('aria-invalid="true"');
    expect(renderToStaticMarkup(createElement(TextField, { label: "Source", value: "", onChange: noop, error: "Must start with https://" }))).toContain("Must start with https://");
  });

  it("show a date in UTC and flag one before the minimum", () => {
    const html = renderToStaticMarkup(createElement(DateTimeField, { label: "Deadline", valueSec: 1_814_399_999, minSec: 1_900_000_000, onChange: noop, demo: "propose-deadline" }));
    expect(html).toContain('value="2027-06-30T23:59"');
    expect(html).toContain('min="2030-03-17T17:46"');
    expect(html).toContain("UTC");
    expect(html).toContain("Pick 2030-03-17 17:46 UTC or later");
  });

  it("clamp the progress bar and say how far", () => {
    expect(renderToStaticMarkup(createElement(ProgressBar, { valueBps: 6_931, label: "29,113 of 42,000 USDC (69.31%)" }))).toContain('aria-valuenow="69"');
    const full = renderToStaticMarkup(createElement(ProgressBar, { valueBps: 12_100 }));
    expect(full).toContain('aria-valuenow="100"');
    expect(full).toContain("bg-pos-bright");
    expect(renderToStaticMarkup(createElement(ProgressBar, { valueBps: -5 }))).toContain('aria-valuenow="0"');
  });

  it("offer a clear button only with text", () => {
    expect(renderToStaticMarkup(createElement(SearchField, { value: "", onChange: noop, demo: "market-search" }))).not.toContain("market-search-clear");
    expect(renderToStaticMarkup(createElement(SearchField, { value: "fed", onChange: noop, demo: "market-search" }))).toContain('data-demo="market-search-clear"');
  });

  it("make a radio group of chips and a disclosure button", () => {
    const chips = renderToStaticMarkup(
      createElement(ChipScroller<"all" | "single">, {
        options: [
          { value: "all", label: "All markets", demo: "market-filter-all" },
          { value: "single", label: "Single events", demo: "market-filter-single", disabled: true },
        ],
        value: "all",
        onChange: noop,
        demo: "market-filters",
      }),
    );
    expect(chips).toContain('role="radiogroup"');
    expect(chips).toMatch(/aria-checked="true"[^>]*data-demo="market-filter-all"/);
    expect(chips).toMatch(/<button[^>]*disabled=""[^>]*data-demo="market-filter-single"/);
    const closed = renderToStaticMarkup(createElement(Disclosure, { title: "Rules", demo: "rules", children: "body" }));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("body");
    expect(renderToStaticMarkup(createElement(Disclosure, { title: "Rules", defaultOpen: true, children: "body" }))).toContain("body");
  });
});
