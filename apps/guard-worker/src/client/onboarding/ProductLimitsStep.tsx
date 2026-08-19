import { familyControl } from "@standardagents/brolly-core";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartDual, levelColor, useUsageSeries } from "../components/limits-chart";
import { billableMetricIds, costSeries, metricSeries } from "../components/limits-chart/api";
import { defaultLevelValues, toleranceDefaults } from "../components/limits-chart/defaults";
import { Icon, ProductIcon, Spinner, Switch } from "../components/ui";
import type { AlertLevel, OnboardingData, Policy } from "../types";
import { StepIntro } from "./BudgetSteps";
import { emptyScope, updateScope } from "./limits-policy";

type OpenState = string | null;
type SidebarItem = { id: string; label: string };
type SectionInfo = { items: SidebarItem[]; hasUsage: boolean; deviated: string[] };

/** Fallback offset (page header + step rail) when the rail cannot be measured. */
const DEFAULT_STICKY_TOP = 108;

/** Bottom edge of the wizard's sticky step rail, so sticky parts sit right under it. */
function useStickyTop(): number {
  const [top, setTop] = useState(DEFAULT_STICKY_TOP);
  useEffect(() => {
    const measure = () => {
      const rail = document.querySelector<HTMLElement>("[data-wizard-rail]");
      if (rail) setTop(Math.round(rail.getBoundingClientRect().bottom));
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return top;
}

/**
 * Product limits: every product family down the page, each with its per-day
 * and per-billing-cycle controls side by side and bound together (opening a
 * row in one opens the same row in the other). A sticky sidebar lists
 * products and their billable items and follows the scroll position.
 */
export function ProductLimitsStep({ token, data, policy, levels, setPolicy }: {
  token: string;
  data: OnboardingData;
  policy: Policy;
  levels: AlertLevel[];
  setPolicy: Dispatch<SetStateAction<Policy>>;
}) {
  const families = data.families;
  const STICKY_TOP = useStickyTop();
  const chartLevels = useMemo(() => levels.map((level, index) => ({ id: level.id, label: level.label, color: levelColor(index, levels.length) })), [levels]);
  const [openByScope, setOpenByScope] = useState<Record<string, OpenState>>({});
  const [infoByScope, setInfoByScope] = useState<Record<string, SectionInfo>>({});
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  // Order: products with detected historical usage first, then products
  // without; inside each group, quarantine-capable products lead. Products
  // whose history has not loaded yet count as detected until known.
  const ordered = useMemo(() => {
    const rank = (family: OnboardingData["families"][number]) => {
      const info = infoByScope[`family:${family.family}`];
      const detected = info ? info.hasUsage : true;
      return (detected ? 0 : 2) + (familyControl(family.family) ? 0 : 1);
    };
    return [...families].sort((left, right) => rank(left) - rank(right));
  }, [families, infoByScope]);
  const detected = ordered.filter(family => infoByScope[`family:${family.family}`]?.hasUsage ?? true);
  const undetected = ordered.filter(family => !(infoByScope[`family:${family.family}`]?.hasUsage ?? true));
  const [activeScope, setActiveScope] = useState<string | null>(null);
  const currentActive = activeScope ?? (ordered[0] ? `family:${ordered[0].family}` : null);

  // Scroll spy: a product becomes active once its top has risen past a line
  // 30% of the way down the visible area.
  useEffect(() => {
    const update = () => {
      const line = STICKY_TOP + (window.innerHeight - STICKY_TOP) * 0.3;
      let current: string | null = null;
      for (const family of ordered) {
        const scope = `family:${family.family}`;
        const top = sectionRefs.current[scope]?.getBoundingClientRect().top;
        if (top !== undefined && top <= line) current = scope;
      }
      setActiveScope(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [ordered, STICKY_TOP]);

  const reportInfo = useCallback((scope: string, info: SectionInfo) => {
    setInfoByScope(current => {
      const previous = current[scope];
      if (previous && previous.hasUsage === info.hasUsage && sameItems(previous.items, info.items) && previous.deviated.join("|") === info.deviated.join("|")) return current;
      return { ...current, [scope]: info };
    });
  }, []);
  // Product sections start collapsed; the sidebar or a row click opens one row.
  const openFor = (scope: string): OpenState => openByScope[scope] ?? null;
  const setOpenFor = (scope: string, next: OpenState) => setOpenByScope(current => ({ ...current, [scope]: next }));
  const jumpTo = (scope: string, item?: string) => {
    if (item) setOpenFor(scope, item);
    const section = sectionRefs.current[scope];
    if (section) window.scrollTo({ top: window.scrollY + section.getBoundingClientRect().top - STICKY_TOP - 8, behavior: "smooth" });
  };

  if (!families.length) return <StepIntro title="Product limits">No products with usage were found for this account yet.</StepIntro>;

  return <>
    <StepIntro title="Product limits">
      Cost and billable usage limits for each product: per day on the left, per billing cycle on the right. Each starts from its typical history and your risk tolerance.
    </StepIntro>
    <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-8 max-lg:grid-cols-1">
      <nav className="sticky self-start max-lg:static" style={{ top: STICKY_TOP + 16 }} aria-label="Products">
        {[{ title: "Detected historical usage", list: detected }, { title: "No usage detected", list: undetected }].filter(group => group.list.length > 0).map(group => (
          <div key={group.title} className="mb-4">
            <h4 className="mb-1.5 px-2 text-[10.5px] font-extrabold uppercase tracking-[.08em] text-faint">{group.title}</h4>
            <ol className="grid gap-1 text-[13px]">
              {group.list.map(family => {
                const scope = `family:${family.family}`;
                const active = scope === currentActive;
                const openItem = openFor(scope);
                const familyOn = policy.limits?.day?.[scope]?.enabled ?? true;
                const items = infoByScope[scope]?.items ?? [];
                const deviated = new Set(infoByScope[scope]?.deviated ?? []);
                return (
                  <li key={scope}>
                    <button type="button" onClick={() => jumpTo(scope)} aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left font-[680] transition-colors ${active ? "bg-orange-soft text-orange-deep" : "text-muted hover:bg-panel-soft hover:text-ink"} ${familyOn ? "" : "opacity-50"}`}>
                      <ProductIcon family={family.family} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{family.label}{deviated.size > 0 && <span className="ml-0.5 text-orange" title="Some limits differ from the tolerance defaults">*</span>}</span>
                      {familyControl(family.family) && <Icon name="shield" className="size-3.5 flex-none opacity-70" aria-label="Quarantine available" />}
                    </button>
                    {active && items.length > 0 && (
                      <ol className="ml-[30px] mt-0.5 mb-1 grid gap-0.5 border-l border-line pl-2.5">
                        {items.map(item => {
                          const itemActive = item.id === openItem;
                          const changed = deviated.has(item.id);
                          return (
                            <li key={item.id}>
                              <button type="button" onClick={() => jumpTo(scope, item.id)} aria-current={itemActive ? "true" : undefined}
                                className={`flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[12.5px] ${changed ? "font-bold text-ink" : "text-muted hover:text-ink"}`}>
                                <i className={`size-1.5 flex-none rounded-full ${itemActive ? "bg-orange" : "bg-transparent"}`} aria-hidden="true" />
                                <span className="truncate">{item.label}{changed && <span className="ml-0.5 text-orange" title="Differs from the tolerance defaults">*</span>}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </nav>
      <div className="grid min-w-0 gap-12">
        {ordered.map(family => {
          const scope = `family:${family.family}`;
          return (
            <ProductSection
              key={scope}
              ref={element => { sectionRefs.current[scope] = element; }}
              token={token}
              scope={scope}
              family={family.family}
              label={family.label}
              levels={chartLevels}
              policy={policy}
              setPolicy={setPolicy}
              open={openFor(scope)}
              onOpenChange={next => setOpenFor(scope, next)}
              onInfo={info => reportInfo(scope, info)}
            />
          );
        })}
      </div>
    </div>
  </>;
}

function ProductSection({ ref, token, scope, family, label, levels, policy, setPolicy, open, onOpenChange, onInfo }: {
  ref: (element: HTMLElement | null) => void;
  token: string;
  scope: string;
  family: string;
  label: string;
  levels: Array<{ id: string; label: string; color: string }>;
  policy: Policy;
  setPolicy: Dispatch<SetStateAction<Policy>>;
  open: OpenState;
  onOpenChange: (next: OpenState) => void;
  onInfo: (info: SectionInfo) => void;
}) {
  const usage = useUsageSeries(token, scope);
  const STICKY_TOP = useStickyTop();
  const order = useMemo(() => levels.map(level => level.id), [levels]);
  const tolerance = policy.riskTolerance?.percentOfTypical;
  const dayLimits = policy.limits?.day?.[scope];
  const cycleLimits = policy.limits?.cycle?.[scope];
  const familyEnabled = dayLimits?.enabled ?? true;
  const policyScope = { key: scope, kind: "family", family } as const;
  const setFamilyEnabled = (next: boolean) => {
    for (const window of ["day", "cycle"] as const) setPolicy(previous => updateScope(previous, window, policyScope, current => ({ ...current, enabled: next })));
  };
  useEffect(() => {
    if (!usage.data) return;
    const data = usage.data;
    const hasUsage = data.series.some(point => point.costUsd > 0 || Object.values(point.metrics).some(value => value > 0));
    const metricIds = billableMetricIds(data);
    // An item is "deviated" when either window's saved values differ from
    // what the tolerance would set for it.
    const deviates = (series: ReturnType<typeof costSeries>, saved: Record<string, number> | undefined, dailySaved: Record<string, number> | undefined, window: "day" | "cycle") => {
      if (!tolerance || !saved || !order.every(id => Number.isFinite(saved[id]))) return false;
      const days = (() => { const at = Date.parse(`${data.today}T00:00:00Z`); const cycle = data.cycles.find(item => at >= item.startsAt && at < item.endsAt); return cycle ? Math.max(1, Math.round((cycle.endsAt - cycle.startsAt) / 86_400_000)) : 30; })();
      const seed = window === "cycle" && dailySaved ? Object.fromEntries(Object.entries(dailySaved).map(([id, value]) => [id, value * days])) : undefined;
      const expected = defaultLevelValues(series, data.cycles, data.today, order, {}, undefined, seed, toleranceDefaults(series, data.cycles, data.today, order, tolerance, window));
      return order.some(id => expected[id] !== saved[id]);
    };
    const deviated: string[] = [];
    if (deviates(costSeries(data), dayLimits?.cost, undefined, "day") || deviates(costSeries(data), cycleLimits?.cost, dayLimits?.cost, "cycle")) deviated.push("cost");
    for (const id of metricIds) {
      if (deviates(metricSeries(data, id), dayLimits?.usage?.[id], undefined, "day") || deviates(metricSeries(data, id), cycleLimits?.usage?.[id], dayLimits?.usage?.[id], "cycle")) deviated.push(id);
    }
    onInfo({ hasUsage, deviated, items: [{ id: "cost", label: "Cost" }, ...metricIds.map(id => ({ id, label: data.metrics[id]?.label ?? id }))] });
  }, [usage.data, onInfo, order, tolerance, dayLimits, cycleLimits]);
  const control = familyControl(family);

  return (
    <section ref={ref} className="min-w-0" style={{ scrollMarginTop: STICKY_TOP + 8 }} aria-label={`${label} limits`}>
      {/* Sticky under the page header and step rail; the next product's header pushes it away. */}
      <header className="sticky z-20 -mx-2 mb-4 flex items-center gap-3 border-b border-line bg-panel px-2 pt-4 pb-3" style={{ top: STICKY_TOP }}>
        <ProductIcon family={family} />
        <h3 className="text-[17px] font-[750]">{label}</h3>
        <span className="ml-1 inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[11px] font-bold text-chip-ink"><Icon name="bell" className="size-3.5" /> Alerts</span>
          {control && <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[11px] font-bold text-chip-ink" title="Brolly can quarantine this product."><Icon name="shield" className="size-3.5" /> Quarantine</span>}
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11.5px] font-bold text-muted">
          <span>{familyEnabled ? "Monitored" : "Not monitored"}</span>
          <Switch label={`Monitor ${label}`} on={familyEnabled} onChange={setFamilyEnabled} title={familyEnabled ? "Monitored. Switch off to ignore this product." : "Not monitored."} />
        </span>
      </header>
      {usage.loading && <div className="grid h-[200px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>}
      {usage.error && <p className="text-[13px] text-faint">Usage history is unavailable. {usage.error}</p>}
      {usage.data && (
        <div className={familyEnabled ? "" : "pointer-events-none opacity-50"} aria-disabled={!familyEnabled}>
        <LimitsChartDual
          data={usage.data}
          levels={levels}
          day={dayLimits ?? emptyScope()}
          cycle={cycleLimits ?? emptyScope()}
          onChange={(window, change) => setPolicy(previous => updateScope(previous, window, policyScope, change))}
          tolerance={tolerance}
          open={familyEnabled ? open : null}
          onOpenChange={onOpenChange}
        />
        </div>
      )}
    </section>
  );
}

function sameItems(left: SidebarItem[] | undefined, right: SidebarItem[]): boolean {
  return !!left && left.length === right.length && left.every((item, index) => item.id === right[index]!.id && item.label === right[index]!.label);
}
