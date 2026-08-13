import { useCallback, useEffect, useRef, useState } from "react";
import { api, authSession, logoutSession } from "./api";
import { AppShell } from "./components/layout";
import { connectionHealth } from "./lib/health";
import { BudgetWizard } from "./onboarding/BudgetWizard";
import { AssetsPage } from "./pages/AssetsPage";
import { ConfigurationPage } from "./pages/ConfigurationPage";
import { IncidentsPage } from "./pages/IncidentsPage";
import { LoadingScreen, LoginPage } from "./pages/LoginPage";
import { OverviewPage } from "./pages/OverviewPage";
import { SettingsPage } from "./pages/SettingsPage";
import { useRoute } from "./router";
import type { DashboardData, Incident, OnboardingData, ReleaseStatus } from "./types";

const RELEASE_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export default function App() {
  const [token, setToken] = useState("");
  const [oauthConfigured, setOauthConfigured] = useState(true);
  const [credentialStorageReady, setCredentialStorageReady] = useState(true);
  const [onboarding, setOnboarding] = useState<OnboardingData | null>(null);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [route, navigate] = useRoute();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(0);
  const [focusIncidentId, setFocusIncidentId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState("");
  const [release, setRelease] = useState<ReleaseStatus | null>(null);
  const releaseCheckedAt = useRef(0);

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
      setToken("");
      setOnboarding(null);
      setDashboard(null);
    } finally {
      setLoading(false);
    }
  }, [loadDashboard]);

  const loadRelease = useCallback(async (activeToken = token) => {
    const next = await api<ReleaseStatus>("/api/releases", activeToken);
    setRelease(next);
    releaseCheckedAt.current = Date.now();
    return next;
  }, [token]);

  useEffect(() => {
    void authSession().then(session => {
      setOauthConfigured(session.oauthConfigured);
      setCredentialStorageReady(session.credentialStorageReady);
      if (session.authenticated) {
        setToken("session");
        return bootstrap("session");
      }
      setLoading(false);
    }).catch(cause => {
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoading(false);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!token || !onboarding?.complete) return;
    const interval = window.setInterval(() => void loadDashboard().catch(() => undefined), 60_000);
    return () => window.clearInterval(interval);
  }, [loadDashboard, onboarding?.complete, token]);

  useEffect(() => {
    if (!token || !onboarding?.complete) return;
    let retry: number | undefined;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void loadRelease().then(next => {
        if (next.checking) retry = window.setTimeout(check, 5_000);
      }).catch(() => undefined);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible" && Date.now() - releaseCheckedAt.current >= RELEASE_CHECK_INTERVAL_MS) check();
    };
    check();
    const interval = window.setInterval(check, RELEASE_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      if (retry !== undefined) window.clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [loadRelease, onboarding?.complete, token]);

  async function logout() {
    await logoutSession();
    setToken("");
    setOnboarding(null);
    setDashboard(null);
    setRelease(null);
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

  if (loading && !token) return <LoadingScreen />;
  if (!token) return <LoginPage error={error} oauthConfigured={oauthConfigured} credentialStorageReady={credentialStorageReady} />;
  if (loading && !onboarding) return <LoadingScreen />;
  if (onboarding && (!onboarding.complete || wizardOpen)) {
    return (
      <BudgetWizard
        data={onboarding}
        token={token}
        editing={wizardOpen}
        initialStep={wizardStep}
        onCancel={wizardOpen ? () => setWizardOpen(false) : undefined}
        onLogout={() => void logout()}
        onSaved={async () => {
          const next = await api<OnboardingData>("/api/onboarding", token);
          setOnboarding(next);
          setWizardOpen(false);
          await loadDashboard();
        }}
      />
    );
  }
  if (!dashboard) return error ? <LoginPage error={error} oauthConfigured={oauthConfigured} credentialStorageReady={credentialStorageReady} /> : <LoadingScreen />;

  const connection = connectionHealth(dashboard);

  return (
    <AppShell
      route={route}
      onNavigate={navigate}
      data={dashboard}
      connection={connection}
      scanning={scanning}
      onScan={() => void scan()}
      onBudgets={() => void openWizard(1)}
      onLogout={() => void logout()}
      release={release}
    >
      {route === "overview" && (
        <OverviewPage
          data={dashboard}
          connection={connection}
          token={token}
          scanError={scanError}
          onNavigate={navigate}
          onOpenIncident={openIncident}
          onBudgets={() => void openWizard(1)}
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
        <AssetsPage data={dashboard} token={token} onNavigate={navigate} onBudgets={() => void openWizard(3)} />
      )}
      {route === "configuration" && (
        <ConfigurationPage
          data={dashboard}
          connection={connection}
          token={token}
          onNavigate={navigate}
          onEditInstall={() => void openWizard(5)}
        />
      )}
      {route === "settings" && (
        <SettingsPage
          data={dashboard}
          connection={connection}
          token={token}
          onNavigate={navigate}
          onBudgets={() => void openWizard(1)}
          onLogout={logout}
          release={release}
          onReleaseRefresh={() => void loadRelease()}
        />
      )}
    </AppShell>
  );
}
