import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type RefObject, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { PRODUCT_ICON } from "../lib/meta";
import type { NotificationKind } from "../types";

export type IconName =
  | "alert" | "arrow" | "bell" | "check" | "chevron" | "clipboard" | "clock" | "external" | "gauge" | "info"
  | "layers" | "lock" | "logout" | "pause" | "pulse" | "radar" | "refresh" | "search" | "shield" | "sliders" | "trend" | "wallet" | "x";

const ICON_PATHS: Record<IconName, ReactNode> = {
  alert: <><path d="M12 3 2.8 19h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
  arrow: <path d="m9 5 7 7-7 7" />,
  bell: <><path d="M6 9.5a6 6 0 1 1 12 0c0 4.6 1.8 5.8 1.8 5.8H4.2S6 14.1 6 9.5Z" /><path d="M10 19.5a2.3 2.3 0 0 0 4 0" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  clipboard: <><rect x="6" y="5" width="12" height="16" rx="2" /><path d="M9 5V3h6v2M9 10h6M9 14h6" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" /></>,
  external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6H5V6h6" /></>,
  gauge: <><path d="M4 17a8 8 0 1 1 16 0" /><path d="m12 17 4-6" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  layers: <><path d="m12 3 9 5-9 5-9-5 9-5Z" /><path d="m3 12 9 5 9-5M3 16l9 5 9-5" /></>,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>,
  pause: <path d="M9 5v14M15 5v14" />,
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

/** Inline stroke icon. `className` sets size and color; the default is the 18px body-text size. */
export function Icon({ name, className = "size-[18px]" }: { name: IconName; className?: string }) {
  return (
    <svg className={`inline-block flex-none ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

/** Cloudflare brand mark used on actions that hand control to Cloudflare. */
export function CloudflareLogo() {
  return (
    <svg className="h-auto w-6 shrink-0 fill-current" viewBox="12 13.5 25 12" aria-hidden="true">
      <path d="M28.8868 24.7745L29.0095 24.35C29.1558 23.8449 29.1014 23.378 28.8559 23.0349C28.6302 22.7189 28.2539 22.5328 27.797 22.5112L19.1416 22.4009C19.0833 22.3978 19.0351 22.3715 19.0054 22.3283C18.9753 22.2839 18.9683 22.2268 18.9869 22.172C19.0154 22.0867 19.0999 22.0223 19.1879 22.0184L27.9236 21.9077C28.9597 21.8602 30.0816 21.0194 30.4745 19.994L30.9727 18.6924C30.9864 18.657 30.9926 18.6194 30.9923 18.5817C30.9922 18.5612 30.9907 18.5406 30.9862 18.5203C30.4201 15.9761 28.1497 14.0736 25.4348 14.0736C22.9333 14.0736 20.8092 15.6882 20.0474 17.9322C19.5557 17.5633 18.9267 17.3672 18.2506 17.4348C17.0504 17.554 16.086 18.5203 15.9667 19.7204C15.9354 20.0319 15.9609 20.3325 16.0327 20.615C14.0722 20.6721 12.5 22.2782 12.5 24.2524C12.5 24.4311 12.5135 24.6067 12.5386 24.7784C12.5509 24.8618 12.6212 24.9243 12.7053 24.9243L28.6846 24.9262C28.6862 24.9262 28.6876 24.9255 28.6892 24.9254C28.7806 24.9234 28.861 24.8629 28.8868 24.7745Z" />
      <path d="M31.7695 18.7879C31.6892 18.7879 31.6093 18.7902 31.5298 18.7941C31.5167 18.7948 31.5042 18.798 31.4923 18.8022C31.4508 18.8167 31.4177 18.8503 31.4051 18.8941L31.0648 20.0695C30.9185 20.5746 30.9729 21.0412 31.2184 21.3842C31.4441 21.7007 31.8204 21.8863 32.2773 21.9079L34.1224 22.0187C34.1768 22.0213 34.2247 22.0476 34.254 22.09C34.2848 22.1348 34.2918 22.1923 34.2733 22.2471C34.2443 22.3324 34.1602 22.3968 34.0726 22.4007L32.1553 22.5114C31.1145 22.5593 29.9927 23.3998 29.5998 24.4251L29.4612 24.7871C29.436 24.8526 29.483 24.9223 29.5522 24.9258C29.554 24.9258 29.5556 24.9264 29.5573 24.9264H36.1542C36.233 24.9264 36.3032 24.8751 36.3244 24.7994C36.439 24.3919 36.5 23.9624 36.5 23.5183C36.5 20.9057 34.3821 18.7879 31.7695 18.7879Z" />
    </svg>
  );
}

export function Brand({ large = false }: { large?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-[9px] font-[780] tracking-[-.4px] text-ink ${large ? "text-[28px]" : "text-[19px]"}`}>
      <span className={`grid place-items-center bg-orange text-white ${large ? "size-[46px] rounded-[11px] [&>svg]:size-[33px]" : "size-8 rounded-lg [&>svg]:size-6"}`}><Umbrella /></span>
      <span>Brolly</span>
    </span>
  );
}

/** Cloudflare product glyph, rendered bare from the local docs icon set via a mask so it inherits color. */
export function ProductIcon({ family, tone = "neutral", size = "md" }: { family: string; tone?: "neutral" | "orange"; size?: "sm" | "md" }) {
  const icon = PRODUCT_ICON[family] ?? "dns";
  const compact = size === "sm";
  return (
    <span
      className={`product-glyph relative inline-block ${compact ? "size-[18px]" : "size-[26px]"} flex-none ${tone === "orange" ? "text-orange-deep" : "text-[#566070] dark:text-[#aab3bd]"}`}
      style={{ "--product-icon": `url(/cloudflare-icons/${icon}.svg)` } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

const EXPAND_MS = 260;

/**
 * Height + opacity transition on one clock. The content stays mounted while
 * it collapses, so open and close both animate over the same duration and the
 * closing region never snaps. Children render lazily: closed regions pay
 * nothing.
 */
export function Expander({ open, children, innerClassName = "" }: { open: boolean; children: () => ReactNode; innerClassName?: string }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) { setMounted(true); return; }
    const timer = setTimeout(() => setMounted(false), EXPAND_MS);
    return () => clearTimeout(timer);
  }, [open]);
  return (
    <div className="grid" style={{ gridTemplateRows: open ? "1fr" : "0fr", transition: `grid-template-rows ${EXPAND_MS}ms cubic-bezier(.2,.7,.2,1)` }} aria-hidden={!open}>
      <div className="min-h-0 overflow-hidden">
        <div className={innerClassName} style={{ opacity: open ? 1 : 0, transition: `opacity ${EXPAND_MS}ms cubic-bezier(.2,.7,.2,1)` }}>
          {mounted && children()}
        </div>
      </div>
    </div>
  );
}

/** Compact accessible switch used by limit and monitoring controls. */
export function Switch({ label, on, onChange, disabled = false, title }: {
  label: string;
  on: boolean;
  onChange(next: boolean): void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="inline-flex cursor-pointer items-center has-[:disabled]:cursor-default" title={title} onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={on}
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        className="peer sr-only"
        onChange={event => onChange(event.target.checked)}
        onClick={event => event.stopPropagation()}
      />
      <span
        className="relative inline-block h-[14px] w-[24px] rounded-full bg-[#c3cad2] transition-colors peer-checked:bg-[#1a9c8c] peer-focus-visible:shadow-[0_0_0_3px_#f6821f33] peer-disabled:opacity-55 dark:bg-[#505862] after:absolute after:top-[2px] after:left-[2px] after:size-[10px] after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-[10px]"
        aria-hidden="true"
        onClick={() => { if (!disabled) onChange(!on); }}
      />
    </label>
  );
}

/**
 * Anchored floating panel rendered through a portal, so it escapes any
 * `overflow` clipping ancestor (horizontal scrollers clip vertically too).
 * Position is fixed and recomputed from the anchor on scroll and resize.
 */
export function Popover({ anchor, open, side = "bottom", align = "start", className, children }: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  side?: "top" | "bottom";
  align?: "start" | "end" | "stretch";
  className?: string;
  children: ReactNode;
}) {
  const [box, setBox] = useState<{ top?: number; bottom?: number; left?: number; right?: number; width?: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) { setBox(null); return; }
    const update = () => {
      const rect = anchor.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 6;
      setBox({
        ...(side === "bottom" ? { top: rect.bottom + gap } : { bottom: window.innerHeight - rect.top + gap }),
        ...(align === "end" ? { right: window.innerWidth - rect.right } : { left: rect.left }),
        ...(align === "stretch" ? { width: rect.width } : {}),
      });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [anchor, open, side, align]);
  // Keep the panel inside the viewport when it is wider than its anchor.
  const panel = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!box || !panel.current) { setShift(0); return; }
    const rect = panel.current.getBoundingClientRect();
    const overflow = rect.right - (window.innerWidth - 8);
    setShift(overflow > 0 ? -overflow : 0);
  }, [box, children]);
  if (!open || !box) return null;
  return createPortal(
    <div ref={panel} className={cx("fixed z-50", className)} style={{ ...box, transform: shift ? `translateX(${shift}px)` : undefined }}>{children}</div>,
    document.body,
  );
}

/** Official notification-channel brand mark served from local assets (see docs/notification-brand-icons.md). */
export function ChannelLogo({ kind }: { kind: NotificationKind }) {
  if (!["cloudflare_email", "discord", "slack", "twilio"].includes(kind)) {
    const label = kind === "webhook" ? "{}" : kind === "resend" ? "R" : "P";
    return (
      <span className="grid size-[38px] flex-none place-items-center rounded-lg border border-line-soft bg-white text-[13px] font-extrabold text-[#566070]" aria-hidden="true">
        <strong>{label}</strong>
      </span>
    );
  }
  return (
    <span className="grid size-[38px] flex-none place-items-center rounded-lg border border-line-soft bg-white" aria-hidden="true">
      <img src={`/brand-icons/${kind}.svg`} alt="" className="size-[22px]" />
    </span>
  );
}

/**
 * Hover/focus tooltip. Hidden panels use `hidden` (display:none, not visibility)
 * so they never inflate the page's scrollable overflow. `flip` opens the panel
 * upward (sidebar footer).
 */
export function InfoTip({ label, align = "left", flip = false, children }: { label: string; align?: "left" | "right"; flip?: boolean; children: ReactNode }) {
  return (
    <span className="group/tip relative z-[5] inline-flex align-middle">
      <button
        type="button"
        className="inline-grid size-[18px] cursor-help place-items-center rounded-full border border-[#aeb6c0] bg-white p-0 text-[11px] font-[850] leading-none text-[#59636f] hover:border-orange hover:text-orange-deep hover:outline-3 hover:outline-[#f6821f24] focus-visible:border-orange focus-visible:text-orange-deep focus-visible:outline-3 focus-visible:outline-[#f6821f24] dark:border-[#626c77] dark:bg-[#20252b] dark:text-chip-ink"
        aria-label={label}
      >
        i
      </button>
      <span
        role="tooltip"
        className={[
          "absolute hidden w-[min(390px,calc(100vw-32px))] rounded-panel border border-tip-line bg-tip px-4 py-3.5 text-left text-[12.5px] leading-[1.5] font-normal whitespace-normal text-ink shadow-tip",
          "opacity-0 -translate-y-1 transition-[opacity,transform] duration-[130ms] starting:opacity-0 starting:-translate-y-1",
          "group-hover/tip:block group-hover/tip:translate-y-0 group-hover/tip:opacity-100 group-focus-within/tip:block group-focus-within/tip:translate-y-0 group-focus-within/tip:opacity-100",
          "before:absolute before:size-2.5 before:rotate-45 before:border-t before:border-l before:border-tip-line before:bg-tip before:content-['']",
          "[&_h4]:mt-2.5 [&_h4]:mb-[3px] [&_h4]:text-[12.5px] [&_h4:first-child]:mt-0 [&_p]:mb-2 [&_p]:text-tip-ink [&_p:last-child]:mb-0",
          align === "right" ? "-right-2 before:right-3" : "-left-2 before:left-3",
          flip
            ? "bottom-[calc(100%+10px)] before:-bottom-1.5 before:rotate-[225deg]"
            : "top-[calc(100%+10px)] before:-top-1.5",
        ].join(" ")}
      >
        {children}
      </span>
    </span>
  );
}

const SEVERITY_COLOR: Record<string, string> = {
  emergency: "text-[#c22a20]",
  critical: "text-[#b14d00]",
  warning: "text-[#96650a]",
  info: "text-[#49677d]",
  failed: "text-[#c22a20]",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex w-max items-center gap-1.5 text-[12px] font-[750] capitalize ${SEVERITY_COLOR[severity] ?? "text-muted"}`}>
      <i className="size-2 rounded-full bg-current" />
      {severity}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="flex w-max max-w-full overflow-x-auto rounded-field bg-[#e7eaee] p-[3px] dark:bg-[#252a31]" role="group" aria-label={ariaLabel}>
      {options.map(option => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            className={`cursor-pointer whitespace-nowrap rounded border-0 px-[11px] py-1.5 text-[13px] font-semibold capitalize ${
              active
                ? "bg-white text-ink shadow-[0_1px_3px_#10182821] dark:bg-[#3a4048] dark:text-white dark:shadow-[0_1px_3px_#0005]"
                : "bg-transparent text-muted"
            }`}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
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
    <div className={`text-center text-muted ${compact ? "px-4 py-7" : "px-5 py-[46px]"}`}>
      <Icon name={icon} className="size-9 rounded-full bg-good-bg p-2 text-good" />
      <h3 className="mt-3 mb-1 text-[15px] text-ink">{title}</h3>
      {children && <p className="mx-auto max-w-[52ch] text-[13px]">{children}</p>}
    </div>
  );
}

function useDialogFocus(onClose: () => void) {
  const panelRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus?.();
    };
  }, []);

  return panelRef;
}

/** Centered dialog with backdrop dismissal, Escape handling, and focus restoration. */
export function Modal({ header, onClose, children, labelledBy }: {
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
  labelledBy: string;
}) {
  const panelRef = useDialogFocus(onClose);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-[#14171b66] p-4 backdrop-blur-[2px] dark:bg-[#050608aa]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        className="my-auto flex max-h-[calc(100vh-32px)] w-[min(680px,100%)] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-drawer outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-6 py-5 [&_h2]:m-0 [&_h2]:text-[22px] [&_h2]:tracking-[-.02em] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-[13px] [&_p]:text-muted">
          {header}
          <IconButton className="flex-none" aria-label="Close" onClick={onClose}><Icon name="x" /></IconButton>
        </header>
        <div className="overflow-y-auto p-6">{children}</div>
      </section>
    </div>,
    document.body,
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
  const panelRef = useDialogFocus(onClose);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-[#14171b66] backdrop-blur-[2px] dark:bg-[#050608aa]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside
        className="flex h-full w-[min(560px,100vw)] flex-col bg-[#f5f6f8] shadow-drawer outline-none dark:bg-[#111419]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="flex justify-between gap-3 border-b border-line bg-panel px-[22px] py-5 [&_h2]:mt-2.5 [&_h2]:mb-[3px] [&_h2]:text-[22px] [&_h2]:tracking-[-.02em] [&_p]:m-0 [&_p]:text-[13px] [&_p]:break-words [&_p]:text-muted">
          {header}
          <IconButton className="flex-none" aria-label="Close" onClick={onClose}><Icon name="x" /></IconButton>
        </header>
        <div className="flex flex-col gap-[13px] overflow-auto p-[18px]">{children}</div>
        {footer && <footer className="mt-auto flex justify-between gap-2.5 border-t border-line bg-panel px-[18px] py-[13px]">{footer}</footer>}
      </aside>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Shared primitives. Every repeated visual composition in the dashboard is a
   component here; pages compose these and add layout utilities inline.
--------------------------------------------------------------------------- */

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

const BUTTON_VARIANT: Record<ButtonVariant, string> = {
  primary: "border-orange bg-orange text-white not-disabled:hover:border-orange-hover not-disabled:hover:bg-orange-hover",
  secondary: "border-line-strong bg-panel text-ink not-disabled:hover:border-faint not-disabled:hover:bg-panel-soft dark:not-disabled:hover:bg-[#252a31]",
  quiet: "border-transparent bg-transparent text-muted not-disabled:hover:bg-[#e8ebee] not-disabled:hover:text-ink dark:not-disabled:hover:bg-[#252a31]",
  danger: "border-[#c22f2f] bg-[#c22f2f] text-white not-disabled:hover:bg-[#a82121]",
};

export function Button({ variant = "secondary", size, full = false, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: "small";
  full?: boolean;
}) {
  return (
    <button
      type={type}
      className={cx(
        "inline-flex cursor-pointer items-center justify-center gap-[7px] rounded-field border font-[620] transition-[background-color,border-color,box-shadow] duration-[130ms] disabled:cursor-not-allowed disabled:opacity-50 [&>svg]:size-4",
        size === "small" ? "min-h-[30px] px-2.5 text-[12.5px]" : "min-h-9 px-3.5 text-[13.5px]",
        BUTTON_VARIANT[variant],
        full && "w-full",
        className,
      )}
      {...rest}
    />
  );
}

/** Text-only action styled like a link. `inline` flows with surrounding prose. */
export function LinkButton({ inline = false, className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { inline?: boolean }) {
  return (
    <button
      type={type}
      className={cx(
        "cursor-pointer border-0 bg-transparent p-0 font-[620] text-blue hover:underline",
        inline ? "inline text-[length:inherit]" : "inline-flex items-center gap-1 text-[13px] [&>svg]:size-3.5",
        className,
      )}
      {...rest}
    />
  );
}

/** Small in-progress arc for inline "still working" states next to a label. */
export function Spinner({ className }: { className?: string }) {
  return <i className={cx("inline-block size-3 flex-none animate-spin rounded-full border-2 border-line border-t-orange motion-reduce:[animation-duration:2s]", className)} aria-hidden="true" />;
}

/** Round 34px icon-only button. */
export function IconButton({ className, type = "button", ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cx("grid size-[34px] cursor-pointer place-items-center rounded-full border border-line bg-panel text-muted hover:border-[#b7bfc8] hover:text-ink dark:hover:border-[#69737e]", className)}
      {...rest}
    />
  );
}

/** Small uppercase label above a heading. */
export function Eyebrow({ tone = "faint", className, children }: { tone?: "faint" | "orange"; className?: string; children: ReactNode }) {
  return <p className={cx("mb-1.5 text-[11px] font-[750] uppercase tracking-[.12em]", tone === "orange" ? "text-orange-deep" : "text-faint", className)}>{children}</p>;
}

/** Bordered card. Most page content lives in one of these. */
export function Panel({ className, children, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return <section className={cx("relative mb-[18px] rounded-panel border border-line bg-panel shadow-panel", className)} {...rest}>{children}</section>;
}

/** Panel heading row: title + optional sub copy on the left, actions on the right. */
export function PanelHead({ title, sub, actions, eyebrow, level = 2, titleExtra, className }: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
  level?: 2 | 3;
  /** Rendered inline after the title (info tips, badges). */
  titleExtra?: ReactNode;
  className?: string;
}) {
  const Heading = level === 2 ? "h2" : "h3";
  const headingClass = level === 2 ? "m-0 text-[16.5px] tracking-[-.01em]" : "m-0 text-[14.5px]";
  return (
    <div className={cx("flex flex-wrap items-start justify-between gap-4 px-5 pt-4 pb-3", className)}>
      <div className="min-w-0">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        {titleExtra ? <span className="inline-flex items-center gap-[7px]"><Heading className={headingClass}>{title}</Heading>{titleExtra}</span> : <Heading className={headingClass}>{title}</Heading>}
        {sub && <p className="mt-[3px] max-w-[72ch] text-[13px] text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small footer line under a panel body. */
export function PanelFoot({ icon, children, aside }: { icon?: IconName; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex items-start gap-2 border-t border-line-soft px-5 py-2.5 text-[12px] text-faint">
      {icon && <Icon name={icon} className="mt-px size-3.5" />}
      <span className="min-w-0 flex-1">{children}</span>
      {aside && <span className="ml-auto whitespace-nowrap">{aside}</span>}
    </div>
  );
}

/** Inline status message (form errors, save confirmations). */
export function Notice({ tone, className, children, ...rest }: React.HTMLAttributes<HTMLDivElement> & { tone: "error" | "success" }) {
  return (
    <div
      className={cx(
        "rounded-field border px-3 py-[9px] text-[13px]",
        tone === "error" ? "border-danger-line bg-danger-bg text-danger-ink" : "border-good-line bg-good-bg text-good",
        className,
      )}
      role={tone === "error" ? "alert" : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

const FIELD = "w-full rounded-field border border-field-line bg-field text-ink focus:border-orange focus:shadow-[0_0_0_3px_#f6821f24] focus:outline-none";

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cx(FIELD, "min-h-10 px-[11px]", className)} {...rest} />;
}

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx(FIELD, "min-h-10 px-[11px]", className)} {...rest} />;
}

/** Stacked label + control + optional hint. */
export function Field({ label, hint, className, children }: { label: ReactNode; hint?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <label className={cx("my-[13px] flex flex-col gap-1.5 text-[13px] font-[680]", className)}>
      {label}
      {hint && <small className="font-[450] leading-[1.5] text-muted">{hint}</small>}
      {children}
    </label>
  );
}

export type Tone = "neutral" | "good" | "warn" | "danger" | "blue" | "purple" | "orange";

const TONE_FILL: Record<Tone, string> = {
  neutral: "bg-chip text-chip-ink",
  good: "bg-good-bg text-good",
  warn: "bg-warn-bg text-warn",
  danger: "bg-danger-bg text-danger",
  blue: "bg-blue-bg text-blue-ink",
  purple: "bg-purple-bg text-purple-ink",
  orange: "bg-orange-soft text-orange-deep",
};

/** Filled status pill / badge. `shape="tag"` gives the square uppercase variant used for action states and tiers. */
export function Pill({ tone = "neutral", shape = "pill", dot = false, className, children }: {
  tone?: Tone;
  shape?: "pill" | "tag";
  dot?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "inline-flex w-max items-center gap-1.5 whitespace-nowrap font-[750]",
        shape === "pill" ? "rounded-full px-[9px] py-1 text-[11px]" : "rounded px-[7px] py-1 text-[10.5px] uppercase tracking-[.04em]",
        TONE_FILL[tone],
        className,
      )}
    >
      {dot && <i className="size-[7px] rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Table primitives. Put <Tr> around rows so the last row drops its bottom border. */
export function TableScroll({ children }: { children: ReactNode }) {
  // position:relative keeps absolutely-positioned descendants inside the clip.
  return <div className="relative overflow-x-auto">{children}</div>;
}
export function Table({ className, ...rest }: React.TableHTMLAttributes<HTMLTableElement>) {
  return <table className={cx("w-full border-collapse text-[13.5px]", className)} {...rest} />;
}
export function Th({ className, ...rest }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return <th className={cx("whitespace-nowrap border-y border-line-soft bg-panel-soft px-3.5 py-2 text-left text-[11px] font-[750] uppercase tracking-[.07em] text-faint first:pl-5 last:pr-5", className)} {...rest} />;
}
export function Tr({ clickable = false, className, ...rest }: React.HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return <tr className={cx("group/row", clickable && "cursor-pointer hover:bg-hover", className)} {...rest} />;
}
export function Td({ numeric = false, className, ...rest }: React.TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={cx("border-b border-line-soft px-3.5 py-[11px] align-middle first:pl-5 last:pr-5 group-last/row:border-b-0", numeric && "whitespace-nowrap tabular-nums", className)} {...rest} />;
}

/** Definition list of label/value rows. */
export function KeyValueList({ rows, labelWidth = "150px", className }: { rows: Array<[ReactNode, ReactNode]>; labelWidth?: string; className?: string }) {
  return (
    <dl className={cx("m-0", className)}>
      {rows.map(([label, value], index) => (
        <div key={index} className="grid gap-2.5 border-t border-line-soft py-2 text-[13px] first:border-t-0" style={{ gridTemplateColumns: `${labelWidth} 1fr` }}>
          <dt className="text-faint">{label}</dt>
          <dd className="m-0 min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Numbered step marker (control flow, install guides). */
export function StepNumber({ children, size = 26 }: { children: ReactNode; size?: 24 | 26 }) {
  return (
    <span className={cx("grid flex-none place-items-center rounded-full bg-orange-soft font-extrabold text-orange-deep", size === 24 ? "size-6 text-[12px]" : "size-[26px] text-[13px]")}>
      {children}
    </span>
  );
}

/** Bordered card that groups one titled section of drawer or detail content. */
export function DetailBlock({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-panel border border-line bg-panel p-[18px]">
      {title && <h3 className="mt-0 mb-2 text-[14.5px]">{title}</h3>}
      {children}
    </section>
  );
}

/** Full-width secondary-button-styled anchor for links that leave the app (opens Cloudflare). */
export function ExternalAction({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      className="inline-flex min-h-9 w-full cursor-pointer items-center justify-center gap-[7px] rounded-field border border-line-strong bg-panel px-3.5 text-[13.5px] font-[620] text-ink transition-[background-color,border-color,box-shadow] duration-[130ms] hover:border-faint hover:bg-panel-soft dark:hover:bg-[#252a31] [&>svg]:size-4"
      href={href}
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  );
}

/** Rounded count badge used in panel headings. */
export function CountBadge({ tone = "neutral", children }: { tone?: "neutral" | "warning"; children: ReactNode }) {
  return (
    <span className={cx("inline-block whitespace-nowrap rounded-full px-2.5 py-1.5 text-[12px] font-bold", tone === "warning" ? "bg-warn-bg text-warn" : "bg-chip text-ink dark:text-chip-ink")}>
      {children}
    </span>
  );
}

const ACTION_STATE_TONE: Record<string, Tone> = {
  succeeded: "good",
  failed: "danger",
  prepared: "warn",
  rolled_back: "blue",
};

/** Uppercase tag for a control action's lifecycle state. */
export function ActionStatePill({ state, className }: { state: string; className?: string }) {
  return <Pill tone={ACTION_STATE_TONE[state] ?? "neutral"} shape="tag" className={className}>{state.replaceAll("_", " ")}</Pill>;
}

/** Two-line table cell: bold title over a faint caption. */
export function CellStack({ title, sub, titleClassName = "max-w-[46ch] truncate" }: { title: ReactNode; sub: ReactNode; titleClassName?: string }) {
  return (
    <span className="flex min-w-0 flex-col gap-[3px]">
      <strong className={titleClassName}>{title}</strong>
      <small className="text-[12px] text-faint">{sub}</small>
    </span>
  );
}
