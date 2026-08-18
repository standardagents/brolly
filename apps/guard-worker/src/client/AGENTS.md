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
- Read-only charts expose labels and lines without handles, fields, history
  controls, or history keyboard shortcuts.

## Product icons

- `lib/meta.ts` maps every `METRIC_CATALOG` family except `unknown` to a local
  SVG under `public/cloudflare-icons/`.
- Product icons come from Cloudflare's documentation repository. Record each
  upstream filename and retrieval date in `docs/icon-sources.md`.
- `ProductIcon` uses the 34px row tile by default. Inline headings and compact
  coverage lists use `size="sm"`.
- Demo fixtures include every catalog family so icon and label coverage can be
  inspected in first-run and returning-operator views.
