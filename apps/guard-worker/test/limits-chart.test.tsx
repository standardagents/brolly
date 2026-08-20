import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitsChart, levelColor } from "../src/client/components/limits-chart";
import { compactValue, editableValue, parseCompact } from "../src/client/components/limits-chart/LimitsChart";

const LEVELS = [
  { id: "warn", label: "Warn", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#c9412c" },
  { id: "emergency", label: "Emergency", color: "#561a55" },
];

const series = Array.from({ length: 40 }, (_, index) => ({
  day: new Date(Date.UTC(2026, 6, 1 + index)).toISOString().slice(0, 10),
  value: index === 30 ? 40 : 3 + (index % 4),
}));

function render(props: Partial<Parameters<typeof LimitsChart>[0]> = {}) {
  return renderToStaticMarkup(
    <LimitsChart kind="cost" unit="USD" window="day" series={series} today="2026-08-09" levels={LEVELS}
      value={{ warn: 10, critical: 20, emergency: 50 }} onChange={() => {}} {...props} />,
  );
}

describe("LimitsChart", () => {
  it("renders one bar per day in the window and one slider per level", () => {
    const html = render();
    expect((html.match(/<rect [^>]*rx=/g) ?? []).length).toBe(series.length);
    expect((html.match(/role="slider"/g) ?? []).length).toBe(LEVELS.length);
    expect(html).toContain('aria-valuenow="10"');
    expect(html).toContain('aria-valuenow="20"');
    expect(html).toContain('aria-valuenow="50"');
    expect(html).toContain('aria-valuetext="$50.00"');
  });

  it("colors a bar with the highest crossed level", () => {
    const html = render({ value: { warn: 5, critical: 30, emergency: 100 } });
    // The 40-dollar spike crosses "critical"; ordinary days (3–6) cross "warn".
    expect(html).toContain('fill="#c9412c" opacity="1"');
    expect(html).toContain('fill="#e79021" opacity="1"');
    expect(html).not.toContain('fill="#561a55" opacity="1"');
  });

  it("renders a numeric field per level and hides handles and fields in read-only mode", () => {
    expect((render().match(/inputMode="decimal"/g) ?? []).length).toBe(LEVELS.length);
    expect((render().match(/data-action="(?:undo|redo)"/g) ?? []).length).toBe(2);
    expect((render().match(/disabled=""/g) ?? []).length).toBe(2);
    const readOnly = render({ readOnly: true });
    expect(readOnly).not.toContain('role="slider"');
    expect(readOnly).not.toContain("inputMode");
    expect(readOnly).not.toContain(String.raw`data-action="undo"`);
    expect(readOnly).not.toContain(String.raw`data-action="redo"`);
    expect(readOnly).toContain("Emergency");
  });

  it("labels usage charts with the unit and uses the teal accent", () => {
    const html = render({ kind: "usage", unit: "requests", value: { warn: 100, critical: 200, emergency: 500 } });
    expect(html).toContain('data-limits-chart="usage"');
    expect(html).toContain("500 reqs");
    expect(html).toContain('fill="#1a9c8c"');
  });

  it("renders estimated billable cost as a secondary line with a legend", () => {
    const html = render({
      secondarySeries: series.map(point => ({ ...point, value: point.value / 2 })),
      secondaryLabel: "Estimated billable cost",
    });
    expect(html).toContain("data-secondary-cost-series");
    expect(html).toContain("data-cost-series-legend");
  });

  it("paints the cycle running total in the color of the band it crosses and greys the bars", () => {
    const html = render({ window: "cycle", value: { warn: 20, critical: 60, emergency: 1000 } });
    // Cumulative July spend passes 20 and 60, so warn and critical bands both paint the sawtooth.
    expect(html).toContain('fill="#e79021" opacity=".82"');
    expect(html).toContain('fill="#c9412c" opacity=".82"');
    expect(html).toContain('fill="currentColor" opacity="0.16"');
    // The open-ended top band clips from the top of the plot, so totals above the last line still paint.
    const low = render({ window: "cycle", value: { warn: 5, critical: 10, emergency: 20 } });
    expect(low).toContain('fill="#561a55" opacity=".82"');
    expect(low).not.toMatch(/band-emergency"><rect[^>]*height="0"/);
  });

  it("shows the account usage allotment only on cycle charts and keeps distant boundaries off-scale", () => {
    const cycle = render({ kind: "usage", unit: "requests", window: "cycle", includedPerCycle: 50 });
    expect((cycle.match(/data-included-band/g) ?? []).length).toBe(1);
    expect((cycle.match(/data-included-boundary/g) ?? []).length).toBe(1);
    expect((cycle.match(/data-projected-crossing/g) ?? []).length).toBe(1);
    const day = render({ kind: "usage", unit: "requests", window: "day", includedPerCycle: 50 });
    expect(day).not.toContain("data-included-band");
    const distant = render({ kind: "usage", unit: "requests", window: "cycle", includedPerCycle: 10_000 });
    expect(distant).toMatch(/data-included-band="true" data-clamped="true"/);
    expect(distant).not.toContain("data-included-boundary");
  });

  it("shows a non-blocking note when a cycle level is below its daily reference", () => {
    const html = render({ window: "cycle", value: { warn: 10, critical: 40, emergency: 80 }, reference: { warn: 20, critical: 30, emergency: 60 } });
    expect(html).toContain("Warn is below its daily limit ($20.00). A single day can trip this limit.");
  });

  it("drops switched-off levels from the chart but keeps their field, dimmed", () => {
    const html = render({ levelEnabled: { critical: false }, onLevelEnabledChange: () => {} });
    expect((html.match(/role="slider"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('aria-label="Critical limit"');
    expect(html).toContain('aria-label="Critical limit in dollars"');
    expect((html.match(/role="switch"/g) ?? []).length).toBe(3);
  });

  it("keeps switched-off levels in the push order so their fields hold real values", () => {
    // Warn sits above the switched-off Critical; Critical still gets pushed up past Warn.
    const html = render({ levelEnabled: { critical: false }, onLevelEnabledChange: () => {}, value: { warn: 30, critical: 20, emergency: 50 } });
    const critical = html.match(/aria-label="Critical limit in dollars"[^>]*value="([^"]+)"/)?.[1] ?? html.match(/value="([^"]+)"[^>]*aria-label="Critical limit in dollars"/)?.[1];
    expect(critical).toBeDefined();
    expect(Number(critical!.replace(/[^0-9.]/g, ""))).toBeGreaterThan(30);
  });

  it("abbreviates large values in fields and parses abbreviations back", () => {
    expect(compactValue(5_800_000_000, "bytes")).toBe("5.8B");
    expect(compactValue(2_000, "USD")).toBe("2K");
    expect(compactValue(2_100, "USD")).toBe("2.1K");
    expect(compactValue(950, "USD")).toBe("950");
    expect(compactValue(100_500_000, "rows")).toBe("100.5M");
    expect(parseCompact("5.8B")).toBe(5_800_000_000);
    expect(parseCompact("12k")).toBe(12_000);
    expect(parseCompact("$2,000")).toBe(2_000);
    expect(parseCompact("nope")).toBeNull();
    expect(editableValue(5_830_000_000, "bytes")).toBe("5.83B");
    expect(editableValue(2_000, "USD")).toBe("2K");
    expect(editableValue(950, "USD")).toBe("950");
    expect(editableValue(12_500, "USD")).toBe("12.5K");
    expect(parseCompact(editableValue(5_830_000_000, "bytes"))).toBe(5_830_000_000);
    const html = render({ kind: "usage", unit: "bytes", value: { warn: 5_800_000_000, critical: 20_000_000_000, emergency: 50_000_000_000 } });
    expect(html).toContain('value="5.8B"');
  });

  it("assigns an ordered color ramp for any level count", () => {
    const eight = Array.from({ length: 8 }, (_, index) => levelColor(index, 8));
    expect(new Set(eight).size).toBe(8);
    expect(levelColor(0, 3)).not.toBe(levelColor(2, 3));
  });
});
