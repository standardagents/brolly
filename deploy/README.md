# Brolly Guard

This repository is a self-contained Brolly installation created by Cloudflare's
Deploy Button. Cloudflare provisioned the D1 database in `wrangler.jsonc` and
connected this repository to Workers Builds.

Open the deployed Worker URL, choose **Continue with Cloudflare**, and authorize
the one Cloudflare account this Brolly instance should protect. The first
successful sign-in permanently binds that account to this installation.

The deploy command applies Brolly's D1 migrations, publishes the Worker and
dashboard, and creates the credential-encryption secret if it does not already
exist. Later deployments preserve that secret and all D1 data.

The build command performs an offline integrity check of the checked-in Worker,
dashboard, migrations, and Wrangler upload boundary. The application is already
compiled, so this check does not fetch source or generate a second bundle.

## Updates

In Brolly, open **Settings → Updates** and save this repository as
`owner/repository`. While the dashboard is active, Brolly checks for releases
at most hourly. When a banner appears, click **Review update**, run the
**Update Brolly** workflow, review its pull request and Cloudflare preview, then
merge when ready. This works for private repositories and does not give Brolly
a GitHub token. The workflow preserves `wrangler.jsonc`, your D1 database
binding, variables, and secrets.

If your GitHub organization does not allow Actions to create pull requests,
the workflow still pushes the verified update branch and places a prefilled
pull-request comparison link in the run summary.
The updater workflow is installation infrastructure and is not rewritten by
routine application updates.

- Product and installation documentation: <https://brolly.standardagents.ai>
- Source and contributions: <https://github.com/standardagents/brolly>
- Runtime fuse: <https://www.npmjs.com/package/@standardagents/brolly-runtime>

The checked-in `worker.js` and `assets/` files are verified release artifacts
generated from the public Brolly source. Make product changes in the source
repository rather than editing the generated bundle here.
