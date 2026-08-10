export function money(value: number): string {
  if (value < 0.01 && value > 0) return `<$0.01`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: value >= 100 ? 0 : 2, maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
}

export function number(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: Math.abs(value) >= 1_000_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

export function dateTime(value: number | null): string {
  if (!value) return "Not available";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}

export function relativeTime(value: number): string {
  const seconds = Math.round((value - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

export function duration(value: number | null): string {
  if (!value) return "current window";
  if (value % 86_400_000 === 0) return `${value / 86_400_000} day`;
  if (value % 3_600_000 === 0) return `${value / 3_600_000} hour`;
  return `${value / 60_000} min`;
}

export function measurement(value: number, unit: string, windowMs: number | null): string {
  const rendered = unit === "usd" ? money(value) : `${number(value)} ${unit === "rows" ? "rows" : unit === "requests" ? "requests" : unit}`;
  return `${rendered} in ${duration(windowMs)}`;
}

export function metricTitle(metric: string): string {
  return metric.replaceAll("_", " ").replace(/\b\w/g, letter => letter.toUpperCase());
}

export function normalizeNumericDraft(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}
