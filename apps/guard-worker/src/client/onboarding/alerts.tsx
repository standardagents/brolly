import { ChannelList, type NotificationTargetsState } from "../components/notifications";
import { StepIntro } from "./BudgetSteps";

/** Step 2: alert channel connections only. Continue stays locked until one channel exists. */
export function AlertsStep({ token, targets }: { token: string; targets: NotificationTargetsState }) {
  return <>
    <StepIntro title="Connect alert channels">Add at least one channel to continue. You&apos;ll be able to map channels to alert thresholds in the next step.</StepIntro>
    <ChannelList token={token} state={targets} />
  </>;
}
