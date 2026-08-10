import { useCallback, useEffect, useState } from "react";
import { api, forgetToken, rememberToken, savedToken } from "./api";
import { AppShell } from "./components/layout";
import { connectionHealth } from "./lib/health";
import { BudgetWizard } from "./onboarding/BudgetWizard";
import { AssetsPage } from "./pages/AssetsPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { DocsPage } from "./pages/DocsPage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { LoadingScreen, LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useRoute } from "./router";
import type { DashboardData, Incident, OnboardingData } from "./types";

export default function App() {
  const docsPage = window.location.pathname === "/docs";
  const [token, setToken] = useState(savedToken());
  const [onboarding, setOnboarding] = useState<OnboardingData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(Boolean(token));
  const [error, setError] = useState("");
  const [route, navigate] = useRoute();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [focusIncidentId, setFocusIncidentId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");

  const loadDashboard = useCallback(async (activeToken = token) => {
    const next = await api<DashboardData>("/api/dashboard", activeToken);
    setDashboard(next);
    return next;
  }, [token]);

  const bootstrap = useCallback(async (activeToken: string) => {
    setLoading(true);
    setError("");
    try {
      const setup = await api<OnboardingData>("/api/onboarding", activeToken);
      setOnboarding(setup);
      if (setup.complete) await loadDashboard(activeToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      forgetToken();
      setToken("");
      setOnboarding(null);
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [loadDashboard]);

  useEffect(() => { if (token && !docsPage) void bootstrap(token); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (docsPage || !token || !onboarding?.complete) return;
    const interval = window.setInterval(() => void loadDashboard().catch(() => undefined), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard, onboarding?.complete, token]);

  async function login(nextToken: string) {
    rememberToken(nextToken);
    setToken(nextToken);
    await bootstrap(nextToken);
  }

  function logout() {
    forgetToken();
    setToken("");
    setOnboarding(null);
    setDashboard(null);
    setError("");
  }

  async function openWizard(step = 0) {
    const next = await api<OnboardingData>("/api/onboarding", token);
    setOnboarding(next);
    setWizardStep(step);
    setWizardOpen(true);
  }

  async function scan() {
    setScanning(true);
    setScanError("");
    try {
      await api("/api/run", token, { method: "POST" });
      await loadDashboard();
    } catch (cause) {
      setScanError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setScanning(false);
    }
  }

  function openIncident(incident: Incident) {
    setFocusIncidentId(incident.id);
    navigate("incidents");
  }

  if (docsPage) return <DocsPage />;
  if (!token) return <LoginPage onLogin={login} error={error} />;
  if (loading && !onboarding) return <LoadingScreen />;
  if (onboarding && (!onboarding.complete || wizardOpen)) {
    return (
      <BudgetWizard
        data={onboarding}
        token={token}
        editing={wizardOpen}
        initialStep={wizardStep}
        onCancel={wizardOpen ? () => setWizardOpen(false) : undefined}
        onSaved={async () => {
          const next = await api<OnboardingData>("/api/onboarding", token);
          setOnboarding(next);
          setWizardOpen(false);
          await loadDashboard();
        }}
      />
    );
  }
  if (!dashboard) return error ? <LoginPage onLogin={login} error={error} /> : <LoadingScreen />;

  const connection = connectionHealth(dashboard);

  return (
    <AppShell
      route={route}
      onNavigate={navigate}
      data={dashboard}
      connection={connection}
      scanning={scanning}
      onScan={() => void scan()}
      onBudgets={() => void openWizard(0)}
      onLogout={logout}
    >
      {route === "overview" && (
        <OverviewPage
          data={dashboard}
          connection={connection}
          token={token}
          scanError={scanError}
          onNavigate={navigate}
          onOpenIncident={openIncident}
          onBudgets={() => void openWizard(0)}
        />
      )}
      {route === "incidents" && (
        <IncidentsPage
          data={dashboard}
          token={token}
          onRefresh={loadDashboard}
          focusIncidentId={focusIncidentId}
          onFocusHandled={() => setFocusIncidentId(null)}
        />
      )}
      {route === "assets" && (
        <AssetsPage data={dashboard} token={token} onNavigate={navigate} onBudgets={() => void openWizard(2)} />
      )}
      {route === "configuration" && (
        <ConfigurationPage
          data={dashboard}
          connection={connection}
          token={token}
          onNavigate={navigate}
          onEditInstall={() => void openWizard(4)}
        />
      )}
      {route === "settings" && (
        <SettingsPage
          data={dashboard}
          connection={connection}
          token={token}
          onNavigate={navigate}
          onBudgets={() => void openWizard(0)}
          onLogout={logout}
        />
      )}
    </AppShell>
  );
}
