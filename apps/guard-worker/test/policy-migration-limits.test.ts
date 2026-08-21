import { DEFAULT_POLICY, resourceId } from "@standardagents/brolly-core";
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

      await seedLegacyAccountUsageRule(testD1.db, "day", "workers:requests", 99);
      await seedLegacyAccountUsageRule(testD1.db, "billing_cycle", "workers:requests", 999);
      const rootId = resourceId("account-1", "account", "account", "account-1");
      await testD1.db.prepare(
        `INSERT INTO alert_rules(
           id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
           notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,confirmation_window_ms,
           enabled,retired,legacy_policy_key,created_at,updated_at
         ) VALUES('manual-rule',?1,?2,NULL,'workers:requests','usage','day','[]',0,0,300000,1,0,'manual:account:usage:workers:requests',?3,?3)`,
      ).bind("account-1", rootId, Date.now()).run();
      await testD1.db.prepare(
        `INSERT INTO settings(key,value,updated_at) VALUES('usage_ledger_policy_version',?1,?2)`,
      ).bind(policy.version, Date.now()).run();

      await migrateLegacyPolicyRules(testD1.db, "account-1", policy);

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
         WHERE r.legacy_policy_key='limits:day:family:workers:usage:workers:requests' AND l.level_id='warning'`,
      ).first()).resolves.toMatchObject({ measurement: "usage", period: "day", enabled: 1, line_enabled: 0, threshold_value: 100 });
      await expect(testD1.db.prepare(
        `SELECT enabled,retired FROM alert_rules WHERE legacy_policy_key='limits:day:account:usage:workers:requests'`,
      ).first()).resolves.toMatchObject({ enabled: 0, retired: 1 });
      await expect(testD1.db.prepare(
        `SELECT enabled,retired FROM alert_lines WHERE alert_rule_id='policy:day:account:usage%3Aworkers%3Arequests' AND level_id='warning'`,
      ).first()).resolves.toMatchObject({ enabled: 0, retired: 1 });
      await expect(testD1.db.prepare(
        `SELECT r.enabled,l.threshold_value FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
         WHERE r.legacy_policy_key='limits:billing_cycle:family:workers:usage:workers:requests' AND l.level_id='warning'`,
      ).first()).resolves.toMatchObject({ enabled: 0, threshold_value: 3_000 });
      await expect(testD1.db.prepare(
        `SELECT enabled,retired FROM alert_rules WHERE legacy_policy_key='limits:billing_cycle:account:usage:workers:requests'`,
      ).first()).resolves.toMatchObject({ enabled: 0, retired: 1 });
      await expect(testD1.db.prepare(
        `SELECT enabled FROM alert_rules WHERE legacy_policy_key='manual:account:usage:workers:requests'`,
      ).first()).resolves.toMatchObject({ enabled: 1 });
      await expect(testD1.db.prepare(
        `SELECT value FROM settings WHERE key='usage_ledger_policy_migration_revision'`,
      ).first()).resolves.toMatchObject({ value: "included-quota-scopes-v2" });
    } finally {
      testD1.close();
    }
  });

  it("lets an explicit family usage limit win over an account fallback", async () => {
    const testD1 = createTestD1();
    try {
      await new LedgerStore(testD1.db).syncMetricCatalog();
      const policy = structuredClone(DEFAULT_POLICY);
      policy.version = "chart-family-conflict";
      policy.limits = {
        day: {
          account: { cost: {}, usage: { "workers:requests": { warning: 100, critical: 200, emergency: 400 } } },
          "family:workers": { cost: {}, usage: { "workers:requests": { warning: 10, critical: 20, emergency: 40 } } },
        },
        cycle: {},
      };

      await migrateLegacyPolicyRules(testD1.db, "account-1", policy, true);

      await expect(testD1.db.prepare(
        `SELECT l.threshold_value FROM alert_rules r JOIN alert_lines l ON l.alert_rule_id=r.id
         WHERE r.legacy_policy_key='limits:day:family:workers:usage:workers:requests' AND l.level_id='warning'`,
      ).first()).resolves.toMatchObject({ threshold_value: 10 });
      await expect(testD1.db.prepare(
        `SELECT COUNT(*) AS count FROM alert_rules WHERE legacy_policy_key='limits:day:account:usage:workers:requests' AND retired=0`,
      ).first()).resolves.toMatchObject({ count: 0 });
    } finally {
      testD1.close();
    }
  });
});

async function seedLegacyAccountUsageRule(db: D1Database, period: "day" | "billing_cycle", metricDefinitionId: string, threshold: number): Promise<void> {
  const accountId = "account-1";
  const rootId = resourceId(accountId, "account", "account", accountId);
  const now = Date.now();
  const ruleId = `policy:${period}:account:usage%3Aworkers%3Arequests`;
  const key = `limits:${period}:account:usage:${metricDefinitionId}`;
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO resources(
         id,account_id,parent_resource_id,product_family,resource_type,cloudflare_id,display_name,
         first_seen_at,last_seen_at,coverage_status,control_capability,runtime_fuse_status,
         auto_quarantine_policy,tier,excluded,collector_key,dataset,metadata_json
       ) VALUES(?1,?2,NULL,'account','account',?2,'Account',?3,?3,'missing','none','unknown','inherit','unclassified',0,'test','test','{}')`,
    ).bind(rootId, accountId, now),
    db.prepare(
      `INSERT INTO alert_rules(
         id,account_id,target_resource_id,target_selector_json,metric_definition_id,measurement,period,
         notification_target_ids_json,auto_quarantine,auto_quarantine_contributors,confirmation_window_ms,
         enabled,retired,legacy_policy_key,created_at,updated_at
       ) VALUES(?1,?2,?3,NULL,?4,'usage',?5,'[]',0,0,300000,1,0,?6,?7,?7)`,
    ).bind(ruleId, accountId, rootId, metricDefinitionId, period, key, now),
    db.prepare(
      `INSERT INTO alert_lines(
         id,alert_rule_id,level_id,label,color,priority,threshold_value,action,repeat_interval_ms,
         enabled,retired,created_at,updated_at
       ) VALUES(?1,?2,'warning','Warning','#f59e0b',0,?3,'notify',NULL,1,0,?4,?4)`,
    ).bind(`${ruleId}:warning`, ruleId, threshold, now),
  ]);
}
