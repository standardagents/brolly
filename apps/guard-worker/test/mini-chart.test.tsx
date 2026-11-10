import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MiniChart } from "../src/client/components/limits-chart/UsageDimensions";

const levels = [
  { id: "warn", label: "Warning", color: "#e79021" },
  { id: "critical", label: "Critical", color: "#a8232f" },
];

function render(window: "day" | "cycle") {
  return renderToStaticMarkup(
    <MiniChart
      series={[
        { day: "2026-08-01", value: 0, coverage: "measured" },
        { day: "2026-08-02", value: 40, coverage: "measured" },
        { day: "2026-08-03", value: 0, missing: true, coverage: "unavailable" },
      ]}
      cycles={[{ startsAt: Date.UTC(2026, 7, 1), endsAt: Date.UTC(2026, 8, 1) }]}
      today="2026-08-03"
      window={window}
      levels={levels}
      values={{ warn: 20, critical: 60 }}
      accent="#2f6fd6"
    />,
  );
}

describe("MiniChart coverage baseline", () => {
  it.each(["day", "cycle"] as const)("draws measured days blue and unavailable days gray in %s mode", window => {
    const html = render(window);
    expect((html.match(/data-spark-baseline="measured"/g) ?? [])).toHaveLength(2);
    expect((html.match(/data-spark-coverage="unavailable"/g) ?? [])).toHaveLength(1);
    expect(html).toContain('data-spark-baseline="measured" x="0"');
    expect(html).toContain('fill="#2f6fd6" shape-rendering="crispEdges"');
    expect(html).toContain('data-spark-coverage="unavailable" x="80" y="0" width="40.2" height="28" fill="var(--faint)" opacity=".14"');
  });
});
