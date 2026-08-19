# Guard dashboard client

The root `AGENTS.md` frontend and behavior-test rules apply throughout this
directory.

## Limits charts

- `components/limits-chart/` owns chart math, interaction, history, data access,
  and rendering. Keep reusable chart behavior independent from onboarding and
  settings pages.
- Daily points use UTC calendar days from Brolly's stored ledger. The component
  performs no Cloudflare requests.
- Pointer previews derive from the complete level map captured at pointer-down.
  Undo and Redo record committed releases, field changes, and keyboard steps.
  History is per chart, remains in memory, and holds at most 50 snapshots.
- Usage dimensions require separate chart histories. Preserve the metric key on
  the `LimitsChart` instance when tabs switch.
- Risk tolerance seeds missing values from the median nonzero history. Saved
  values remain detached. Reset to tolerance records one undoable chart change.
- Billing-cycle defaults keep daily limits times the cycle length as a default
  lower bound. Cycle edits have no hard daily floor. A lower cycle value shows a
  non-blocking reference note.
- Compact row values contain one level swatch and one value. Level labels and
  per-level switches belong in the expanded chart fields.
- First-run setup saves through the onboarding route. The reopened Budget
  settings flow saves through the policy PUT route. Both paths materialize
  chart maps into ledger alert rules.
- Read-only charts expose labels and lines without handles, fields, history
  controls, or history keyboard shortcuts.

## Limits UI

- `components/ui.tsx` owns `Switch`.
- `components/limits-chart/LevelValueField.tsx` owns every editable level
  value. Use `chip` for compact row values, `bare` below expanded charts, and
  `boxed` when a standalone chart needs cards.
- `components/limits-chart/LimitsChartDual.tsx` owns the daily and billing-cycle
  shell for one policy scope. Account limits use its `costOnly` mode.
- `onboarding/limits-policy.ts` owns scope updates and the daily legacy-map
  mirroring required by server and dashboard readers.
- New limit editors must compose these components and helpers.

## Product icons

- `lib/meta.ts` maps every `METRIC_CATALOG` family except `unknown` to a local
  SVG under `public/cloudflare-icons/`.
- Product icons come from Cloudflare's documentation repository. Record each
  upstream filename and retrieval date in `docs/icon-sources.md`.
- `ProductIcon` uses the 34px row tile by default. Inline headings and compact
  coverage lists use `size="sm"`.
- Demo fixtures include every catalog family so icon and label coverage can be
  inspected in first-run and returning-operator views.
