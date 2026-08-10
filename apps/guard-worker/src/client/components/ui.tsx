import { useEffect, useRef, type ReactNode } from "react";
import { PRODUCT_ICON } from "../lib/meta";
import type { NotificationKind } from "../types";

export type IconName =
  | "alert" | "arrow" | "bell" | "check" | "chevron" | "clock" | "external" | "gauge" | "info"
  | "layers" | "logout" | "pulse" | "radar" | "refresh" | "search" | "shield" | "sliders" | "trend" | "wallet" | "x";

const ICON_PATHS: Record<IconName, ReactNode> = {
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
  arrow: <path d="m9 5 7 7-7 7" />,
  bell: <><path d="M6 9.5a6 6 0 1 1 12 0c0 4.6 1.8 5.8 1.8 5.8H4.2S6 14.1 6 9.5Z" /><path d="M10 19.5a2.3 2.3 0 0 0 4 0" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6H5V6h6" /></>,
  gauge: <><path d="M4 17a8 8 0 1 1 16 0" /><path d="m12 17 4-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  pulse: <path d="M3 12h4l2.5-7 4.5 14 2.5-7H21" />,
  radar: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3" /><path d="m12 12 6-6" /></>,
  refresh: <><path d="M20 11a8 8 0 1 0-2 6" /><path d="M20 4v7h-7" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
  shield: <><path d="M12 3 5 6v5c0 5 3 8 7 10 4-2 7-5 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></>,
  sliders: <><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  trend: <><path d="M3 17.5 8.5 11l4 3.5L20 6" /><path d="M20 6h-4.5M20 6v4.5" /></>,
  wallet: <><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H17v2.5" /><path d="M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1V8.5a1 1 0 0 0-1-1H4Z" /><path d="M15.5 13.5h.01" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICON_PATHS[name]}
    </svg>
  );
}

export function Umbrella() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <path d="M4 20a16 16 0 0 1 32 0c-3.5-2.5-7.2-2.5-10.8 0-3.4-2.5-7-2.5-10.4 0C11.2 17.5 7.6 17.5 4 20Z" fill="currentColor" />
      <path d="M20 7v23.5c0 3.6 5.5 3.6 5.5 0" fill="none" stroke="currentColor" strokeWidth="2.7" strokeLinecap="round" />
    </svg>
  );
}

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`brand ${large ? "large" : ""}`}>
      <span className="brand-mark"><Umbrella /></span>
      <span>Brolly</span>
    </span>
  );
}

/** Cloudflare product glyph, rendered from the local docs icon set via a mask so it inherits color. */
export function ProductIcon({ family, tone = "neutral" }: { family: string; tone?: "neutral" | "orange" }) {
  const icon = PRODUCT_ICON[family] ?? "dns";
  return (
    <span
      className={`product-mark ${tone}`}
      style={{ "--product-icon": `url(/cloudflare-icons/${icon}.svg)` } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

/** Official notification-channel brand mark served from local assets (see docs/notification-brand-icons.md). */
export function ChannelLogo({ kind }: { kind: NotificationKind }) {
  return (
    <span className={`channel-mark ${kind}`} aria-hidden="true">
      <img src={`/brand-icons/${kind}.svg`} alt="" />
    </span>
  );
}

export function InfoTip({ label, align = "left", children }: { label: string; align?: "left" | "right"; children: ReactNode }) {
  return (
    <span className={`info-tip ${align}`}>
      <button type="button" className="info-tip-trigger" aria-label={label}>i</button>
      <span className="info-tip-panel" role="tooltip">{children}</span>
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`severity ${severity}`}><i />{severity}</span>;
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map(option => (
        <button
          key={option.value}
          type="button"
          className={value === option.value ? "active" : ""}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function EmptyState({ icon = "check", title, children, compact = false }: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`empty-state ${compact ? "compact" : ""}`}>
      <Icon name={icon} />
      <h3>{title}</h3>
      {children && <p>{children}</p>}
    </div>
  );
}

/**
 * Right-side drawer with dialog semantics: Escape closes, focus moves into the
 * panel on open, and clicking the backdrop dismisses.
 */
export function Drawer({ header, footer, onClose, children, labelledBy }: {
  header: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
}) {
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={labelledBy} ref={panelRef} tabIndex={-1}>
        <header className="drawer-header">
          {header}
          <button type="button" className="icon-button" aria-label="Close" onClick={onClose}><Icon name="x" /></button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer className="drawer-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
