import { familyControl } from "@standardagents/brolly-core";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { LimitsChartPair, levelColor, useUsageSeries, type UsageSeriesResponse } from "../components/limits-chart";
import { billableMetricIds } from "../components/limits-chart/api";
import { Icon, ProductIcon, Spinner } from "../components/ui";
import type { AlertLevel, OnboardingData, Policy, PolicyLimits, ScopeLimits } from "../types";
import { StepIntro } from "./BudgetSteps";

type Window = keyof PolicyLimits;
type OpenState = { cost: boolean; usage: string | null | undefined };
type SidebarItem = { id: string; label: string };
type SectionInfo = { items: SidebarItem[]; hasUsage: boolean };

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

  // Scroll spy: the last product section whose top has passed the sticky offset is active.
  useEffect(() => {
    const update = () => {
      let current: string | null = null;
      for (const family of ordered) {
        const scope = `family:${family.family}`;
        const top = sectionRefs.current[scope]?.getBoundingClientRect().top;
        if (top !== undefined && top <= STICKY_TOP + 24) current = scope;
      }
      setActiveScope(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, [ordered, STICKY_TOP]);

  const reportInfo = useCallback((scope: string, info: SectionInfo) => {
    setInfoByScope(current => (current[scope] && current[scope]!.hasUsage === info.hasUsage && sameItems(current[scope]!.items, info.items) ? current : { ...current, [scope]: info }));
  }, []);
  // Product sections start collapsed; the sidebar or a row click opens one.
  const openFor = (scope: string): OpenState => openByScope[scope] ?? { cost: false, usage: null };
  const setOpenFor = (scope: string, next: OpenState) => setOpenByScope(current => ({ ...current, [scope]: next }));
  const jumpTo = (scope: string, item?: string) => {
    if (item) setOpenFor(scope, item === "cost" ? { ...openFor(scope), cost: true } : { ...openFor(scope), usage: item });
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
                const open = openFor(scope);
                const items = infoByScope[scope]?.items ?? [];
                const openItem = open.usage === undefined ? items[1]?.id : open.usage;
                return (
                  <li key={scope}>
                    <button type="button" onClick={() => jumpTo(scope)} aria-current={active ? "true" : undefined}
                      className={`flex w-full items-center gap-2 rounded-field px-2 py-1.5 text-left font-[680] transition-colors ${active ? "bg-orange-soft text-orange-deep" : "text-muted hover:bg-panel-soft hover:text-ink"}`}>
                      <ProductIcon family={family.family} size="sm" />
                      <span className="min-w-0 flex-1 truncate">{family.label}</span>
                      {familyControl(family.family) && <Icon name="shield" className="size-3.5 flex-none opacity-70" aria-label="Quarantine available" />}
                    </button>
                    {active && items.length > 0 && (
                      <ol className="ml-[30px] mt-0.5 mb-1 grid gap-0.5 border-l border-line pl-2.5">
                        {items.map(item => {
                          const itemActive = item.id === "cost" ? open.cost : item.id === openItem;
                          return (
                            <li key={item.id}>
                              <button type="button" onClick={() => jumpTo(scope, item.id)}
                                className={`w-full truncate rounded px-1.5 py-1 text-left text-[12.5px] ${itemActive ? "font-bold text-ink" : "text-muted hover:text-ink"}`}>{item.label}</button>
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
  useEffect(() => {
    if (!usage.data) return;
    const hasUsage = usage.data.series.some(point => point.costUsd > 0 || Object.values(point.metrics).some(value => value > 0));
    onInfo({ hasUsage, items: [{ id: "cost", label: "Cost" }, ...billableMetricIds(usage.data).map(id => ({ id, label: usage.data!.metrics[id]?.label ?? id }))] });
  }, [usage.data, onInfo]);
  const daily = policy.limits?.day?.[scope];
  const control = familyControl(family);

  return (
    <section ref={ref} className="min-w-0" style={{ scrollMarginTop: STICKY_TOP + 8 }} aria-label={`${label} limits`}>
      {/* Sticky under the page header and step rail; the next product's header pushes it away. */}
      <header className="sticky z-20 -mx-2 mb-4 flex items-center gap-3 border-b border-line bg-panel px-2 pt-4 pb-3" style={{ top: STICKY_TOP }}>
        <ProductIcon family={family} />
        <h3 className="text-[17px] font-[750]">{label}</h3>
        <span className="ml-1 inline-flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-chip px-2.5 py-1 text-[11px] font-bold text-chip-ink"><Icon name="bell" className="size-3.5" /> Alerts</span>
          <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${control ? "bg-chip text-chip-ink" : "border border-dashed border-line text-faint"}`} title={control ? "Brolly can quarantine this product." : "Quarantine is not available for this product."}>
            <Icon name="shield" className="size-3.5" /> Quarantine
          </span>
        </span>
      </header>
      {usage.loading && <div className="grid h-[200px] place-content-center text-[13px] text-faint"><span className="inline-flex items-center gap-2"><Spinner /> Loading usage history…</span></div>}
      {usage.error && <p className="text-[13px] text-faint">Usage history is unavailable. {usage.error}</p>}
      {usage.data && (
        <div className="grid grid-cols-2 gap-6 max-xl:grid-cols-1">
          {(["day", "cycle"] as const).map(window => (
            <WindowColumn key={window} window={window} data={usage.data!} scope={scope} family={family} token={token} levels={levels}
              policy={policy} setPolicy={setPolicy} daily={daily} open={open} onOpenChange={onOpenChange} />
          ))}
        </div>
      )}
    </section>
  );
}

function WindowColumn({ window, data, scope, family, token, levels, policy, setPolicy, daily, open, onOpenChange }: {
  window: Window;
  data: UsageSeriesResponse;
  scope: string;
  family: string;
  token: string;
  levels: Array<{ id: string; label: string; color: string }>;
  policy: Policy;
  setPolicy: Dispatch<SetStateAction<Policy>>;
  daily: ScopeLimits | undefined;
  open: OpenState;
  onOpenChange: (next: OpenState) => void;
}) {
  const current = policy.limits?.[window]?.[scope] ?? emptyScope();
  const update = (change: (limits: ScopeLimits) => ScopeLimits) => setPolicy(previous => updateScope(previous, window, scope, family, change));
  return (
    <section className="min-w-0">
      <LimitsChartPair
        token={token}
        scope={scope}
        family={family}
        window={window}
        data={data}
        levels={levels}
        open={open}
        onOpenChange={onOpenChange}
        cost={current.cost}
        onCostChange={cost => update(limits => ({ ...limits, cost }))}
        usage={current.usage}
        onUsageChange={usage => update(limits => ({ ...limits, usage }))}
        costFloor={window === "cycle" ? daily?.cost : undefined}
        usageFloor={window === "cycle" ? daily?.usage : undefined}
        tolerance={policy.riskTolerance?.percentOfTypical}
        costEnabled={current.costEnabled ?? true}
        onCostEnabledChange={costEnabled => update(limits => ({ ...limits, costEnabled }))}
        usageEnabled={current.usageEnabled}
        onUsageEnabledChange={usageEnabled => update(limits => ({ ...limits, usageEnabled }))}
        costLevelEnabled={current.costLevelEnabled}
        onCostLevelEnabledChange={costLevelEnabled => update(limits => ({ ...limits, costLevelEnabled }))}
        usageLevelEnabled={current.usageLevelEnabled}
        onUsageLevelEnabledChange={usageLevelEnabled => update(limits => ({ ...limits, usageLevelEnabled }))}
      />
    </section>
  );
}

function updateScope(policy: Policy, window: Window, scope: string, family: string, change: (limits: ScopeLimits) => ScopeLimits): Policy {
  const limits: PolicyLimits = policy.limits
    ? { day: { ...policy.limits.day }, cycle: { ...policy.limits.cycle } }
    : { day: {}, cycle: {} };
  const next = change(limits[window][scope] ?? emptyScope());
  limits[window][scope] = next;
  const result: Policy = { ...policy, limits };
  if (window === "day") result.familyDailySpend = { ...result.familyDailySpend, [family]: next.cost };
  return result;
}

function emptyScope(): ScopeLimits {
  return { cost: {}, usage: {} };
}

function sameItems(left: SidebarItem[] | undefined, right: SidebarItem[]): boolean {
  return !!left && left.length === right.length && left.every((item, index) => item.id === right[index]!.id && item.label === right[index]!.label);
}
