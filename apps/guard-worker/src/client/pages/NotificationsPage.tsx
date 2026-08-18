import { NotificationSection } from "../components/notifications";

export function NotificationsPage({ token }: { token: string }) {
  return <NotificationSection token={token} />;
}
