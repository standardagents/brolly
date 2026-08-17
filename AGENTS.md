# Brolly

Brolly is a self-hosted Cloudflare cost sentinel and emergency control plane.

## Safety invariants

- Brolly must never auto-delete customer data or resources.
- Every monitoring run has hard request, row, sample, and wall-clock budgets.
- Unknown or inaccessible telemetry is an explicit coverage incident, never a healthy signal.
- Automatic actions must be reversible and produce an audit record before execution.
- The Brolly Worker, its D1 database, and notification path are always protected control-plane assets.
- Exact Durable Object quarantine is only available through a signed runtime integration.
- A forensic hold prevents cleanup and resume until an operator explicitly releases it.

## Frontend code standards

These apply to the marketing site (`apps/docs-site`) and the guard dashboard
client (`apps/guard-worker/src/client`):

- **DRY.** Give each shared concept one implementation. Near-duplicates count:
  if code is copied and then varied slightly, extract the common behavior and
  express the variation through data, parameters, slots, or child components.
- **Composition first.** Compose behavior from focused components, hooks, and
  reusable functions in the Composition API sense. Components should
  orchestrate; extract state, effects, and domain logic into hooks, and extract
  repeated UI into shared components. Do not let page components accumulate
  unrelated responsibilities.
- **Tailwind 4 first.** Style with Tailwind utilities in markup whenever
  Tailwind can express the behavior. Semantic CSS is permissible when Tailwind
  4 cannot express it correctly; explain the limitation next to the semantic
  CSS. Keyframes and design tokens (CSS variables) are valid semantic CSS.
  Migrate existing semantic CSS opportunistically when touching it.
- **1,000-line file limit.** A file over 1,000 lines is a code smell — split it
  before it gets there. Enforced by `test/frontend-line-limit.test.ts`, which
  fails `pnpm test` on any oversized file in these trees. Do not raise the
  limit, baseline an oversized file, or add an exemption; rewrite the file.
- **No self-licking ice cream cones, process porn, or compliance theater.**
  Tooling, tests, metrics, abstractions, and documentation must improve the
  product code directly, not exist mainly to justify or perpetuate more tooling
  and process. When a quality violation is found, demand an immediate rewrite
  and fix the code now; never substitute a baseline, exception ledger,
  compliance test, or ceremonial workflow for the refactor.

## Tests must exercise behavior

A test earns its place by calling code and asserting on what it returns,
renders, or persists. Tests that read source files as text and assert on the
presence of strings, class names, imports, or animations are forbidden. They
break on every legitimate rewrite, pass when the feature is broken, and exist
only to make a checklist feel enforced. Concretely:

- Never `readFileSync` a `.ts`, `.tsx`, or `.css` file inside a test and
  `toContain` on it. Import the module and call it, or render the component
  and query the DOM.
- Never test that a label, hint, button text, or copy string exists in a
  source file. If copy matters to behavior, render the component; if it does
  not, do not test it.
- Never test styling by grep. Design rules (Tailwind-first, no semantic class
  names, dark mode) are enforced by review and by rewriting the offending
  code, never by a scanner test.
- Never test that an animation, keyframe, or transition exists.
- Never write a test whose only purpose is to pin the current implementation
  shape (function names, hook signatures, route string literals). Test the
  observable contract instead.

The one exception is `test/frontend-line-limit.test.ts`, which measures a
number and names the file to split. When you find a test that violates this
section, delete it in the same change. Replace it with a behavior test only if
the underlying invariant is real (a security boundary, a data contract, a
calculation), never to preserve coverage numbers.

## Commands

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm dev
pnpm dev:demo
pnpm build:docs
pnpm build:deploy-template
pnpm release:runtime patch --dry-run --yes
```

## Dashboard UI preview

`pnpm dev:demo` serves the guard Worker dashboard on
<http://localhost:5199> against an in-process mock API
(`apps/guard-worker/vite.demo.config.ts`). It needs no Cloudflare account, no
OAuth client, and no D1 database. Use it for any dashboard UI work or review.

`pnpm dev` boots the real Worker instead. That path requires Cloudflare OAuth
and permanent account binding before any page past the login screen renders, so
it cannot show the UI on a machine without an account to bind.

The preview opens signed in on Overview, and its fixtures cover the states worth
reviewing: a critical incident holding a prepared quarantine action awaiting
approval, an acknowledged warning, an informational incident, a resolved past
action, one coverage gap, a partially configured Worker and namespace, a
notification target, and 24 hours of spend history. The Budgets button opens the
onboarding wizard in edit mode, so its steps are reachable without completing
onboarding.

Two rules for changing it:

- The fixture account id must stay a placeholder string. `connectionHealth()`
  keys the "Local preview" banner off that, which is what stops a preview from
  reading as live protection.
- Fixtures must satisfy the response types in
  `apps/guard-worker/src/client/types.ts`. The demo config is inside the
  package's `tsconfig.json`, so `pnpm typecheck` fails when a dashboard API
  response shape changes and its fixture does not.

Mutating routes answer `{ ok: true }` without side effects, so every button is
safe to click. The harness is development-only and never reaches `deploy/`.

The production deployment path for the public docs site is a push from `main`.
GitHub Actions typechecks, builds, verifies the deploy template, and deploys
that commit. Agents should use this path for routine production delivery.

Manual production deployment is reserved for emergencies:

```bash
pnpm deploy:docs
```

The command prints a prominent warning with the branch, commit, working-tree
state, and production URL. It requires `continue` before building and `deploy`
immediately before upload. The package-level docs deployment scripts use the
same confirmations. The CI entry point accepts only the canonical GitHub
Actions `main` environment and the checked-out `GITHUB_SHA`.

The default docs-site Wrangler configuration uses the separate
`brolly-docs-local` Worker name and has no route. The confirmed manual path is
the sole caller of `wrangler.production.jsonc`.

`apps/docs-site` is the universal public site for
`brolly.standardagents.ai`. It is prerendered to static HTML and deployed by
`.github/workflows/deploy-docs.yml` on pushes to `main`. It is intentionally
not part of the customer Deploy to Cloudflare build in `pnpm build`.

`deploy/` is the canonical, fully isolated generated release template used by
the Deploy to Cloudflare button. Cloudflare's installer failed to clone this
repository's nested template reliably, so `.github/workflows/deploy-docs.yml`
builds and verifies `deploy/` on Linux, commits any platform-normalized release
output inside the CI checkout, and publishes it as the root of the
`deploy-template` branch before updating the public site. Run
`pnpm build:deploy-template` after guard Worker changes and commit the resulting
Worker, assets, migrations, and deploy helpers. The dashboard and README must
link to the `deploy-template` branch URL, never the monorepo root or `deploy/`
subdirectory URL.
