# Guard dashboard client

The root `AGENTS.md` frontend and behavior-test rules apply throughout this
directory.

## Limits charts

- `components/limits-chart/` owns chart math, interaction, history, data access,
  and rendering. Keep reusable chart behavior independent from onboarding and
  settings pages.
- Daily points use UTC calendar days from Brolly's stored ledger. The component
  performs no Cloudflare requests.
- Outlier axes use a softened symlog curve with a knee at twice the median
  nonzero value. Rendering and pointer inversion share that axis object.
- Each `LimitsChartDual` metric row owns one linear or logarithmic scale
  preference for its daily/cycle pair. The daily chart renders the selector.
  Both charts read the row preference. Initial mode comes from the row's daily
  and cumulative outlier profile. Scale changes tween the shared axis mapping
  so ticks, levels, fills, markers, and bars move on the same animation clock.
  The logarithmic option uses the chart's zero-safe symlog axis.
- Pointer previews derive from the complete level map captured at pointer-down.
  Undo and Redo record committed releases, field changes, and keyboard steps.
  History is per chart, remains in memory, and holds at most 50 snapshots.
- Usage dimensions require separate chart histories. Preserve the metric key on
  the `LimitsChart` instance when tabs switch.
- Billed-via metrics remain folded into `rowSeries` in the target meter's
  units. Charts present that normalized total without composition seams,
  legends, or tooltip rows.
- `components/limits-chart/defaults.ts` `windowDefaults` is the one definition
  of an unedited map: daily maps come from risk tolerance times the median
  nonzero history; billing-cycle maps are the tolerance-derived daily default
  times the days in the current cycle. Editing a day map never moves the cycle
  default. Reset, follow-through, and the "differs from defaults" marker all
  compare against this one function.
- A tolerance change moves a dimension's day and cycle maps together, and only
  while both still sit on their defaults. Once either is edited, neither
  follows tolerance until both are reset. Day and cycle edits never move each
  other's map, and each window's reset returns only its own map to its
  tolerance base. Reset records one undoable chart change and hides while the
  map already sits on its default. Adherence moves never record undo steps.
- Cycle edits have no hard daily floor. A lower cycle value shows a
  non-blocking reference note.
- Compact row values contain one diamond and one value. The diamond toggles
  its level for that window; level labels and switch controls belong in the
  expanded chart fields. Every other pixel of a row toggles the row open or
  closed — new row content must not add pointer-catching dead space.
- First-run setup saves through the onboarding route. The reopened Budget
  settings flow saves through the policy PUT route. Both paths materialize
  chart maps into ledger alert rules.
- Read-only charts expose labels and lines without handles, fields, history
  controls, or history keyboard shortcuts.
- Account billing-cycle usage charts may include a release-owned Cloudflare
  allotment band. Its fixed boundary remains outside level hit testing and
  chart history. Daily charts use a cycle-to-date quota readout without a
  quota band.
- Account-cycle Warning and Critical defaults use 80 and 100 percent of an
  included allotment when typical usage remains below the allotment. A metric
  whose typical cycle usage exceeds the allotment uses the complete
  tolerance-derived map.
- Paid and unknown product usage charts show the matching meter's estimated
  billable cost in the cycle marker tooltip. The estimate remains separate
  from the primary cost series and has no threshold or history state.

## Limits UI

- `components/ui.tsx` owns `Switch`.
- Alert-level cards keep their configured order in the onboarding board. Their
  entries and action groups remain draggable between cards.
- The onboarding chart guide shows one callout per pagination position. Next,
  Back, section labels, and section dots navigate the same reversible cursor.
  The subtle Skip tutorial action completes an unfinished guide from any card.
  Cards morph between pagination positions within one section. Section changes
  fade the old card before chart motion and reveal the new card after it settles.
  Its charts pass `pointerInteractions={false}` so hover bands, readouts, and
  marker tooltips remain absent from the teaching visual.
- `components/limits-chart/LevelValueField.tsx` owns every editable level
  value. Use `chip` for compact row values, `bare` below expanded charts, and
  `boxed` when a standalone chart needs cards.
- `components/limits-chart/LimitsChartDual.tsx` owns the daily and billing-cycle
  shell for one policy scope. Account limits include cost and account-wide
  billable usage rows so included allotments can seed cycle thresholds.
- `onboarding/limits-policy.ts` owns scope updates and the daily legacy-map
  mirroring required by server and dashboard readers.
- New limit editors must compose these components and helpers.

## Product icons

- `lib/meta.ts` maps every `METRIC_CATALOG` family except `unknown` to a local
  SVG under `public/cloudflare-icons/`.
- Product icons come from Cloudflare's documentation repository. Record each
  upstream filename and retrieval date in `docs/icon-sources.md`.
- `ProductIcon` renders a bare 26px glyph by default. Inline headings and
  compact coverage lists use `size="sm"` (18px).
- Demo fixtures include every catalog family so icon and label coverage can be
  inspected in first-run and returning-operator views.
- Limits charts consume explicit per-metric coverage spans. A missing usage row
  is zero only inside a measured span. Pending and unavailable days render as
  gaps and stay out of projections, defaults, scale inputs, and threshold
  crossings. Partial spans render observed values with partial quality and
  keep absent values as gaps.
