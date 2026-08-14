import { NotificationSection } from "../components/notifications";

export function NotificationsPage({ token }: { token: string }) {
  return (
    <section className="panel">
      <NotificationSection token={token} />
    </section>
  );
}
