import { useEffect, useState } from "react";

export type Route = "overview" | "usage" | "limits" | "alerts" | "assets" | "incidents" | "configuration" | "notifications" | "monitoring" | "backfill" | "settings";

export const ROUTE_PATHS: Record<Route, string> = {
  overview: "/",
  usage: "/usage",
  limits: "/limits",
  alerts: "/alerts",
  incidents: "/incidents",
  assets: "/assets",
  configuration: "/configuration",
  notifications: "/notifications",
  monitoring: "/monitoring",
  backfill: "/backfill",
  settings: "/settings",
};

export const ROUTE_TITLES: Record<Route, string> = {
  overview: "Overview",
  usage: "Usage",
  limits: "Limits",
  alerts: "Alert instances",
  incidents: "Actions & quarantine",
  assets: "Resources",
  configuration: "Configuration & coverage",
  notifications: "Notifications",
  monitoring: "Monitoring cost",
  backfill: "Backfill & retention",
  settings: "Settings",
};

export function routeFromPath(pathname: string): Route {
  const match = (Object.entries(ROUTE_PATHS) as Array<[Route, string]>).find(([, path]) => path === pathname);
  return match?.[0] ?? "overview";
}

export function useRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => routeFromPath(window.location.pathname));

  useEffect(() => {
    const update = () => setRoute(routeFromPath(window.location.pathname));
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);

  function navigate(next: Route) {
    if (next === routeFromPath(window.location.pathname)) return;
    window.history.pushState({}, "", ROUTE_PATHS[next]);
    setRoute(next);
    window.scrollTo({ top: 0 });
  }

  return [route, navigate];
}
