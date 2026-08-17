import { NotificationSection } from "../components/notifications";
import { Panel } from "../components/ui";

export function NotificationsPage({ token }: { token: string }) {
  return (
    <Panel>
      <NotificationSection token={token} />
    </Panel>
  );
}
