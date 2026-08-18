import { DEFAULT_POLICY } from "@standardagents/brolly-core";
import { describe, expect, it } from "vitest";
import { LedgerStore } from "../src/ledger-store";
import { migrateLegacyPolicyRules } from "../src/policy-migration";
import { createTestD1 } from "./d1";

describe("chart policy materialization", () => {
  it("writes daily and cycle chart maps and their switches to alert rules", async () => {
    const testD1 = createTestD1();
    try {
      await new LedgerStore(testD1.db).syncMetricCatalog();
      const policy = structuredClone(DEFAULT_POLICY);
      policy.version = "chart-limits";
      policy.limits = {
        day: {
          account: {
            cost: { warning: 7, critical: 14, emergency: 28 },
            usage: { "workers:requests": { warning: 100, critical: 200, emergency: 400 } },
            costLevelEnabled: { critical: false },
            usageLevelEnabled: { "workers:requests": { warning: false } },
          },
        },
        cycle: {
          account: {
            cost: { warning: 200, critical: 400, emergency: 800 },
            usage: { "workers:requests": { warning: 3_000, critical: 6_000, emergency: 12_000 } },
            usageEnabled: { "workers:requests": false },
          },
        },
      };

      await migrateLegacyPolicyRules(testD1.db, "account-1", policy, true);

      await expect(testD1.db.prepare(
        `SELECT l.threshold_value,l.enabled FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
         WHERE r.legacy_policy_key='account:estimated-cost' AND l.level_id='critical'`,
      ).first()).resolves.toMatchObject({ threshold_value: 14, enabled: 0 });
      await expect(testD1.db.prepare(
        `SELECT r.measurement,r.period,r.enabled,l.threshold_value FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
         WHERE r.legacy_policy_key='limits:billing_cycle:account:cost' AND l.level_id='warning'`,
      ).first()).resolves.toMatchObject({ measurement: "estimated_cost", period: "billing_cycle", enabled: 1, threshold_value: 200 });
      await expect(testD1.db.prepare(
        `SELECT r.measurement,r.period,r.enabled,l.enabled AS line_enabled,l.threshold_value
         FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
         WHERE r.legacy_policy_key='limits:day:account:usage:workers:requests' AND l.level_id='warning'`,
      ).first()).resolves.toMatchObject({ measurement: "usage", period: "day", enabled: 1, line_enabled: 0, threshold_value: 100 });
      await expect(testD1.db.prepare(
        `SELECT enabled FROM alert_rules WHERE legacy_policy_key='limits:billing_cycle:account:usage:workers:requests'`,
      ).first()).resolves.toMatchObject({ enabled: 0 });
    } finally {
      testD1.close();
    }
  });
});
