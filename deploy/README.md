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

- Product and installation documentation: <https://brolly.standardagents.ai>
- Source and contributions: <https://github.com/standardagents/brolly>
- Runtime fuse: <https://www.npmjs.com/package/@standardagents/brolly-runtime>

The checked-in `worker.js` and `assets/` files are verified release artifacts
generated from the public Brolly source. Make product changes in the source
repository rather than editing the generated bundle here.
