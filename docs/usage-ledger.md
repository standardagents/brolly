# Usage ledger and alert API

Brolly maintains an account-wide usage ledger in the installation's D1 database. Scheduled collectors and explicit ingestion jobs query Cloudflare usage APIs. Dashboard charts, limits, alert instances, coverage, monitoring cost, and retention views read stored ledger state.

## Resource and metric model

The resources table is a hierarchy with one account root, product nodes, service scopes, and individual resources where Cloudflare exposes stable identifiers. Each resource stores collection origin, freshness, coverage quality, control capability, runtime-fuse status, protection tier, exclusion state, and an inherited automatic-quarantine policy.

The metric_definitions table is a versioned catalog. It contains detailed usage meters, synthetic estimated-cost meters, authoritative billed-cost meters, and account/product catchalls for billing lines without a detailed collector. Collector capability records state the finest available scope, retention, sampling behavior, current watermark, and a human-readable gap.

## Workers Paid included quotas and plan tiers

Brolly maintains a release-versioned Workers Paid included-quota catalog in
`apps/guard-worker/src/included-quota.ts`. Catalog metric IDs resolve against
the ledger metric definitions. Each catalog change requires a version bump and
fresh verification against Cloudflare's Workers, Workers KV, D1, Durable
Objects, R2, and Queues pricing pages. The catalog remains code-owned because
Cloudflare's billing records and supported APIs provide no included-quantity
field.

The hourly reconciliation cadence reads the account subscriptions endpoint.
An exact `workers_paid` account rate plan selects the paid tier, and an exact
Enterprise rate plan selects the enterprise tier. A successful response with
neither plan selects the free tier. Failed detection records the unknown tier.
The operational credential is tried first, with the Billing Read credential as
the fallback for a forbidden response. An operator override stored in D1 takes
precedence over detection and remains visible with its source in the dashboard,
onboarding, and usage-series responses.

Paid and unknown tiers use the shipped catalog. Enterprise uses the same
values as a standard paid-plan baseline because Cloudflare exposes no
contract-specific allotments or rates. Enterprise cost controls and cost
visualizations remain disabled while usage alerts and controls continue to
operate. Free-tier accounts receive no included-quota boundaries or
allotment-derived defaults because Cloudflare enforces hard usage caps before
spend can accrue.

`GET /api/usage-series` adds an optional `includedPerCycle` value to eligible
metric definitions on their product-family scope. The response also includes
the effective plan tier, its source, and the catalog version. Account and
product-family responses include an `estimatedBillableCostSeries` for paid and
unknown tiers. They also include the same daily estimate split by billed meter
in `estimatedBillableCostByMetric`. These additive series price daily usage
above each catalog allotment at Brolly's existing gross rates and reset at each
billing-cycle boundary. Incoming
Durable Objects WebSocket messages have no meter of their own: the estimator
folds them into the Durable Objects request meter at 20 messages per billed
request, and their dashboard row notes that conversion. Product usage charts
show the matching meter estimate in the billable-usage marker tooltip. The
primary cost series keeps its existing authoritative-then-estimated selection.
Free and Enterprise tiers return no estimated billable-cost points.

Pages Functions requests and shared Workflows request and CPU usage fold into
the Workers pools for account cost estimation. Cloudflare billing rows map to
the receiving Workers meters. The Pages and Workflows source meters remain
independent Product Limits for usage alerts.

The response exposes usage metadata from the account-independent Cloudflare
product metric contract in `PRODUCT_METRIC_CONTRACTS`. The contract records
independent, shared, conditional, quota-only, announced, provider, and
supporting roles. Product Limits includes every contract row marked for that
surface. Dynamic billing SKUs, billed-cost metric definitions, and supporting
reconciliation meters remain stored in the ledger. Product Limits renders
allocated spend through its single Cost row. The unknown billing catchall
contributes to account spend without appearing as a product. The maintained
family matrix and Cloudflare sources live in
[`docs/cloudflare-metric-catalog.md`](cloudflare-metric-catalog.md).

Product billing-cycle usage charts shade the included range and draw a fixed
system boundary at the allotment for each eligible meter. The line is outside
threshold interaction and chart history. Daily charts omit the cycle-scoped
band and retain a cycle-to-date percent readout. A boundary more than three
times the visible data and configured levels stays outside the scale so usage
remains legible. The readout continues to report the allotment and billable
state. Resource charts show their contribution without a separate allotment
boundary.

Closed-row sparklines draw a one-pixel blue baseline for measured zero and
low-value days. Missing days use a full-height neutral gray coverage fill and
contribute no value bar.

Setup starts one account-history request when Billing reaches a final state.
Risk Tolerance and Account Limits share that result so the Account Limits step
can render available history without a second loading pass.

Generic zone HTTP request and response-byte analytics are excluded from the
usage catalog and historical ingestion. Those values are traffic analytics,
rather than Cloudflare billing meters. Zone inventory remains available for
features that need domain scope. Email collects its outbound-sending dataset
per zone. Inbound Email Routing is free and stays outside Product Limits.

Fresh usage limits for a meter with an allotment apply the risk-tolerance
percentages to a baseline: the larger of the meter's typical cycle usage and
its allotment. Typical cycle usage is the median non-zero day over the
lookback window times the days in the current cycle (point-in-time meters use
the median day), so a runaway fortnight does not move it. Inside the free tier
the allotment is the baseline and 100 percent is where billing starts; a meter
that is consistently billable keeps its typical usage as the baseline. Daily
limits for such meters are the baseline spread over the cycle's days times the
same percentages, so the cycle default stays the daily default times the days
in the cycle. Resource limits, metrics without an allotment, and free-tier
accounts keep tolerance-derived defaults. Account limits contain aggregate
dollar-spend thresholds.

Brolly stores these quality states:

| State | Meaning |
| --- | --- |
| complete | The completed window was fully collected and unsampled. |
| partial | A page or collector budget ended before the window completed. |
| sampled | Cloudflare reported adaptive sampling. |
| stale | Stored evidence exists, but its watermark is too old for live enforcement. |
| missing | The dataset, permission, or collector is unavailable. |

Missing data remains missing throughout aggregation and alert evaluation.

Dataset coverage is stored independently in `coverage_intervals`. Each row
identifies an account dataset, an optional zone partition, a half-open time
range, and one of three evidence states:

| Interval state | Chart meaning |
| --- | --- |
| measured | Cloudflare completed the request. An absent usage row is zero. |
| partial | Cloudflare returned some data without completing the interval. Observed values remain visible and carry partial quality. |
| unavailable | Retention, permission, dataset support, or a terminal collection failure prevents a measurement. |

`pending` is derived from active initial-ingestion slices. It is never stored
as historical evidence. The usage-series API returns compact per-metric spans.
Metric-to-dataset mappings preserve required multi-dataset meters and
preferred/fallback alternatives. Zone metrics aggregate each applicable zone.
A measured fallback satisfies its preferred source for the same zone.

Charts draw unavailable and pending days as gaps. Partial days show an
observed value when one exists. Projections, typical-usage baselines, default
limits, and threshold-crossing annotations use measured observations. Partial
values remain visible without setting those derived values. A completed query with no rows is the sole condition
that converts an absent metric value to measured zero.

## Collection and storage

The one-minute cron acts as a scheduler:

- active Worker and Durable Object usage is due every five minutes;
- hot watch is due every minute while a current warning or emergency instance is open and Cloudflare's aligned ingestion watermark has advanced;
- inventory and billing reconciliation are due hourly;
- Analytics dataset capability discovery is due daily;
- retention maintenance is due hourly;
- newest-first historical backfill drains up to the configured slice budget after active protection work.

First-run setup creates a separate initial-ingestion job. It imports daily usage
from Billing and from GraphQL datasets that feed the canonical Product Limits
across a requested 90-day interval. Supporting-only datasets remain outside
setup ingestion.
Dataset ranges before Cloudflare's account-specific retention boundary become
unavailable coverage. Billing Read uses contiguous windows of at most 31 days
and runs before Analytics collection.

Durable Objects and Workers retain detailed priority collection. Every other
available product range starts with a one-row aggregate query that omits date
and resource dimensions. A successful empty result establishes measured-zero
coverage for that range. A positive or truncated result requeues the same
range once for detailed daily collection. A product with no activity therefore
does not incur detailed query and persistence work. Images Transformations is
split into daily, two-row aggregate queries because Cloudflare charges for its
underlying event scan. Each daily result has the granularity required by the
limit chart and does not require a second query.

Initial ingestion opts into Cloudflare's account-based Analytics limiter. Every
request asks Cloudflare for its query cost and remaining GraphQL budget. A
persisted rolling ledger records observed budget debits. A known dataset
reserves 110% of its measured page-unit rate. An unseen bounded page reserves a
conservative per-row estimate with a 125% safety factor and the observed cost
for its logical-query count. Queries without a bounded page use the observed
GraphQL cost until their dataset has a measured debit.
Every path retains a small fixed reserve. Capacity
returns as each recorded debit leaves the five-minute window. A successful
query that leaves zero budget records a provisional full-window estimate for
that dataset. The next clean measurement replaces the provisional value with
at least the account baseline. Responses without budget telemetry use a conservative 270-unit
fallback. A separate ceiling limits each invocation to 300 physical GraphQL
requests. Persisted admission timestamps keep requests at least 1.2 seconds
apart across resumed invocations. After budget telemetry is available, each
admission interval reflects the average of the previous measured debit and the
next predicted debit. Expensive requests contribute half of their interval
before admission and half after admission. Billing remains the hard first
phase. Analytics candidates are ordered by Durable Objects, Workers, and billed
family cost. A paced Durable Objects or Workers slice receives a persisted
admission deadline and debit reservation. A lower-cost activity probe may use
capacity inside that fixed gap when its request preserves both reservations.
Every candidate shares the paced admission lane.
The first detail range created by a positive activity probe receives a protected
calibration reservation against reported remaining capacity. A fresh window is
required only for known scan-heavy datasets or after an actual remote budget
failure. Probe and detail observations use separate quota keys. The first
detail reservation uses reliable probe debit from the same dataset plus the
standard safety margin before it considers unrelated observations. Probe debit
is scaled from the closest observed probe duration to the detail duration and
remains the minimum estimate for small result pages.
Probe admission includes the scanned range length, and an unaffordable probe is
bisected before it reaches Cloudflare. Positive activity rewrites all pending
probe siblings for that dataset in place as detailed ranges.
After a smaller clean-window retry succeeds, pending slices for that dataset
return to pacing from its measured debit.
Discovery and collection stop admitting remote work during the final 12 seconds
of an invocation. Capability checkpoints and pending slices retain the work for
the next pass.

Zone settings requests nest batches of at most ten zones under the connected
account. Historical usage keeps the same ten-zone bound. Admission accounts for
each zone as one logical query unit. Capability discovery checkpoints each completed settings
batch in D1. A two-result queue feeds one serialized D1 consumer. One lease
coordinates browser and cron starts. Each claim reserves bounded D1 capacity.
Shared run and wall-time limits requeue unfinished slices unchanged. HTTP rate
limits defer a slice until reset without consuming a retry. A shared-budget
failure first defers that dataset until a fully recovered window. Eligible
ordinary slices drain before the retry receives a protected reservation. An
HTTP 200 GraphQL budget rejection leaves the shared lane available. HTTP 429
responses retain their account or named-scope cooldown. A recovered grouped-zone failure splits the zone
group before reducing the date range. Account and single-zone failures quarter
ranges of four days or more. Later failures bisect the range. Each new shape
starts with fresh failure accounting. A single-zone, single-day range receives
one fresh-window retry before its dataset becomes unavailable coverage. Every
remaining slice for that dataset becomes terminal so the import can finish. A successful smaller
retry returns pending siblings to measured pacing. Named account and zone responses
pause their scope while other resources continue. A generic budget response
uses Cloudflare's five-minute recovery interval. Scheduled passes run an active
initial import exclusively until it reaches a final state. Dataset and zone
permission failures become terminal coverage partitions. Initial and manual
ingestion write ledger history without evaluating alerts, sending
notifications, or preparing controls.

Daily-only historical datasets request one row beyond the requested day count.
Date-based resource datasets shrink later page limits from observed resource
cardinality with bounded headroom and one truncation sentinel. Other
resource-dimensional datasets retain Cloudflare's discovered page ceiling.
Images Transformations uses daily aggregate queries with a two-row limit. The
daily range bounds Cloudflare's event scan while retaining the chart's required
granularity.

The setup progress bar weights every planned dataset-day and zone-day partition. Completed and terminally unavailable partitions advance the bar. Expected pre-retention intervals count as completed planning work without increasing the error count. Missing Billing access uses the same clean unavailable state. The error control groups permission and collection failures by dataset. Each issue reports its affected date range and zone count. Estimated remaining time uses completed weighted work, elapsed job time, pending requests, and the persisted admission interval. The summary shows the retry countdown while a Cloudflare deadline is active. The progress response also reports Billing, account, and per-product readiness. Risk tolerance and account limits open after Billing and account-root history reach terminal states. Billing releases each metric whose contract accepts Billing history. GraphQL-only metrics retain their own import state. Each product reports Importing, Ready, Limited, or Unavailable. Measured empty coverage counts as usable. A returned row that omits a requested aggregate becomes a metric-specific terminal gap. Expected retention gaps remain clean. Setup can finish while product imports continue.

Active collection reads one fixed completed five-minute window with a two-minute ingestion delay, plus the immediately preceding fixed window as a correction pass. Each continuation remains bound to its original start and end timestamps after a restart. Durable Object datasets and Worker scripts use stable identifier ordering and keyset cursors with pages of up to 10,000 rows. Other product backfill collectors use daily product or resource groups. A dataset that reaches its bounded 10,000-row daily limit records partial coverage. A partial result persists independent active and correction cursors and keeps its interval in partial quality.

Ongoing monitoring rotates aggregate probes across inactive account product
datasets. A newly positive dataset enters bounded detailed collection on a
later five-minute pass. Empty probes write coverage without observations.
Errors remain local to one dataset, and persisted cursors distribute probes
across passes.

Current day and billing-cycle values live in deterministic 8-bit accumulator shards. A shard approaching 1.5 MB splits into deterministic 4-bit secondary segments. Each resource metric retains correction bookkeeping and a bounded 12-scan baseline. Repeating a window is idempotent; a changed Cloudflare result replaces the prior contribution through a delta. Completed local days seal into one usage_daily row per resource and day. Billing cycles use Cloudflare's reconciled boundaries when Billing Read is available and an explicitly approximate calendar boundary during a coverage gap. Cloudflare boundaries replace overlapping provisional calendar cycles. PayGo responses that omit a cycle end derive the next boundary from the account's anchor day.

Initial ingestion writes the same correction-safe accumulator shards without producing alert-change records or reconciling each historical resource after every slice. Historical data is not evaluated for alerts. Completed-day sealing derives daily and billing-cycle totals from the stored day contributions after ingestion. Ongoing monitoring retains full change reconciliation before it evaluates alerts.

Initial Analytics requests use a persisted admission lane with 1.2 seconds between physical requests. The interval stays below Cloudflare's documented sustained account rate after network and clock variance. Cloudflare's returned budget is authoritative for admission. The importer derives a conservative debit from consecutive responses and retains each debit for five minutes. Admission history and observed costs survive Worker restarts.

Local-day totals reconcile every shard that belongs to that day, including a day that spans a billing-cycle boundary. Billing-cycle totals reconcile daily shard contributions across the stored Cloudflare cycle. Incomplete quality and sampling evidence remain attached after short-term scan windows are compacted. The monitoring-cost estimate uses elapsed execution duration as a conservative Worker CPU proxy because a Worker invocation cannot read its own final billed CPU measurement.

The default hard limits for one run are:

| Budget | Default | Hard maximum |
| --- | ---: | ---: |
| GraphQL dataset queries | 300 | 500 |
| REST requests | 50 | 100 |
| D1 rows read | 100,000 | 250,000 |
| D1 rows written | 50,000 | 100,000 |
| Dataset pages | 30 | 50 |
| Resources per transaction | 500 | 1,000 |
| Retries | 3 | 5 |
| Backfill slices | 4 | 12 |
| Wall time | 45 seconds | 55 seconds |

Budget exhaustion records an incomplete monitor run and preserves continuation state. Operators can lower or raise each value on the Monitoring page within the listed product maximum.

## Billing and cost labels

Hourly Billing Read reconciliation requests Cloudflare billable usage with explicit date bounds. A request may align to the current billing-cycle start when the resulting range stays within Cloudflare's 31-day limit. The restricted v2 endpoint is attempted first; a 403 or 404 uses the Billing Read-compatible PayGo endpoint. Billing records define authoritative aggregate charges and actual billing-cycle boundaries. A full-day span without billing rows remains missing data and creates a dated billing coverage record during the initial import.

Granular usage cost remains a model. Brolly proportionally allocates a product/day authoritative charge only among leaf resources with defensible estimated-cost weights. The dashboard labels values as authoritative aggregate, allocated, estimated, sampled, partial, or stale.

An unfamiliar Cloudflare product or metric is stored as a billing line, receives a dynamic metric definition, and creates a billing:catchall capability gap. It remains visible in account and product totals. Detailed collectors retain the usage fields Cloudflare exposes. Metrics such as Pages builds, stored Stream minutes, and Workflow storage remain billing-derived when Analytics has no matching field.

## Limits and alert instances

An alert rule selects one exact resource or a resource selector, one metric
definition, a measurement (`usage`, `estimated_cost`, or `billed_cost`), and a
period (`day` or `billing_cycle`). Policy spend scopes store threshold values in
maps keyed by alert-level ID. Materialization iterates the ordered board and
writes one line for each level with a value. A missing value produces no line.
Each line keeps its level ID and receives priority `position * 10`.

The onboarding policy also stores one shared risk-tolerance percentage map and
daily or billing-cycle chart maps for each account, product, and resource
scope. Empty charts use the median nonzero daily history or the median of at
least two fully covered completed cycles. Saved chart maps remain independent
of later tolerance changes. Policy migration writes these maps and their switch
states to the alert-rule and alert-line tables.

An alert level has a unique case-insensitive label and ordered entries. Warning,
Critical, and Emergency are seeded levels. Custom levels use the same behavior.
The board permits eight levels and retains one level when a column is deleted.
Level entries are additive from left to right. The effective set for a firing
line is the union of entries in all levels at or below its position. A repeated
channel uses the entry from the highest matching position, including that
entry's interval.

Each threshold crossing has a period-specific `alert_instances` identity. A
channel entry with no interval delivers once for the instance. An interval
entry schedules delivery at 5 minutes, 15 minutes, 30 minutes, 1 hour, 3 hours,
6 hours, 12 hours, or 24 hours. Repeats stop when the operator acknowledges the
instance or when it resolves. Active recurring collection evaluates alert rules
after it writes observations. Historical ingestion stays outside alert
evaluation.

Notification destinations support Cloudflare Email, Discord, Postmark, Resend,
Slack, Twilio SMS, and generic HTTPS webhooks. Channel labels are required and
unique without regard to letter case. Cloudflare Email, Resend, and Postmark
channels may contain multiple recipients as one group. Multiple channels can
use the same provider account while remaining distinct groups. Twilio channels
use one destination number. Credentials remain AES-GCM encrypted. A generic
webhook refuses redirects and local or private-network destinations.

Provider records hold one reusable account for each Twilio, Cloudflare Email,
Resend, or Postmark kind. Target rows retain sealed full configurations so the
notifier receives provider values and its destination group together. Provider
updates reseal every target attached to that provider. Removing a channel
removes its level entries and leaves its provider account for explicit removal.

Cloudflare Email token setup verifies activity with `GET
/user/tokens/verify`. The from-address form lists zones from the connected
account. Email Service domain onboarding remains a Cloudflare dashboard task.
The REST notifier records a permanent bounce for the recipient as a failed
delivery.

## Action safety

Prepare entries create an operator-reviewed action. Auto entries can run an
eligible action after all of this evidence exists:

- an exact Worker or Durable Object target;
- complete, fresh, unsampled usage;
- a verified runtime fuse and authoritative owning Worker;
- an eligible tier and an inherited policy without exclusion or denial;
- a sustained breach through the rule's confirmation window;
- no active quarantine or action-rate limit.

If both action variants occur in the effective set, Auto takes precedence for the
same family. The supported families are Worker-ingress stop, Durable Object
quarantine, and queue pause. Other resource families ignore action entries.

Aggregate rules select contributors from a child that crossed its highest level,
then require complete child attribution, at least half of interval usage or
aggregate excess, at least four times the rolling 12-scan baseline, and the
same deterministic winner in two consecutive scans. Ambiguous evidence records
the leading contributors and prepares one exact action for operator review.

Deployment limits allow one changing action per Worker in 15 minutes and three
automatic quarantines per account hour. Brolly writes audit and rollback state
before control execution. Estimated cost, allocated cost, billing totals,
missing data, partial data, sampled data, and stale data cannot authorize an
automatic control. Control-plane assets, refused tiers, denied policies, and
unverified runtime integrations remain ineligible.

## Retention and D1 capacity

Cloudflare Analytics retention varies by dataset. Brolly requests up to 90 days during setup and records the shorter available range for datasets with 30-day, 31-day, 32-day, or 62-day retention. The stored daily history has a separate 730-day ceiling. Account, product, and namespace aggregates receive preservation priority. Individual-resource history targets the same duration under these safeguards:

- 70% capacity records a warning and displays projected retention;
- 80% pauses historical backfill;
- 90% prunes the oldest individual-resource daily rows toward 80%;
- current accumulators, aggregate history, alerts, actions, audit, and billing records remain preserved.

The dashboard reports the oldest retained individual-resource day and recommends paid D1 capacity before high-cardinality history becomes constrained.

## Read and management API

All routes require the existing authenticated Brolly session or break-glass credential.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/usage?resourceId=...&metricId=...&from=YYYY-MM-DD&to=YYYY-MM-DD | Daily history and live accumulator state for one resource. |
| GET | /api/ledger/resources?q=...&family=...&cursor=...&limit=... | Search and traverse canonical resources with stable keyset pagination. |
| PUT | /api/ledger/resources/:id/protection | Set inherited policy, exclusion, or tier. |
| GET | /api/metric-definitions | List active metric definitions. |
| GET | /api/coverage | Collector capabilities, watermarks, cursors, and errors. |
| GET | /api/monitoring-cost | Daily monitoring footprint and recent bounded runs. |
| GET, PUT | /api/monitoring-limits | Read or update per-run collection limits within product hard maximums. |
| GET | /api/retention | Capacity pressure and oldest retained dates. |
| GET, POST | /api/backfill | Inspect or schedule historical jobs within Cloudflare's 90-day source window. |
| GET, POST | /api/onboarding/ingest | Start the idempotent first-run import and read exact per-collector slice progress. |
| GET | /api/cloudflare-zones | List zones from the connected Cloudflare account for Cloudflare Email setup. |
| GET | /api/providers | List saved provider kinds and their from value without credentials. |
| PATCH, DELETE | /api/providers/:kind | Replace or remove a provider account. Removal requires no attached channels. |
| GET, POST | /api/targets | List or save labeled notification channels. |
| PATCH, DELETE | /api/targets/:id | Rename or remove a notification channel. Removal also removes its level entries. |
| GET, POST | /api/alert-levels | Read or insert ordered alert levels. |
| PATCH, DELETE | /api/alert-levels/:id | Rename, reorder, or remove an alert level. One level remains. |
| POST | /api/alert-levels/:id/entries | Add a channel or Prepare/Auto action entry to a level. |
| PATCH, DELETE | /api/alert-levels/:id/entries/:entryId | Change an interval or order, or remove an entry. |
| GET, POST | /api/alert-rules | List or create rules. |
| PUT, DELETE | /api/alert-rules/:id | Update or remove a rule. |
| PUT | /api/alert-lines/:id | Update a level threshold or its enabled state. |
| GET | /api/alert-instances | List period-specific crossings. |
| POST | /api/alerts/:id/acknowledge | Acknowledge one current instance and stop its repeats. |
| POST | /api/run | Run one bounded collector and return budgets, datasets, watermarks, and accounting. |

Rule, line, channel, provider, level, entry, acknowledgment, protection,
backfill, and control changes create audit records.
