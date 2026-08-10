# Durable Object runtime integration

Cloudflare account analytics can identify a hot Durable Object namespace and object ID, but the account API cannot generically stop one object. The owning Worker must expose a signed, narrowly scoped management endpoint.

Brolly sends a short-lived P-256 signed payload containing account, project, object ID, action ID, action, reason, observations, and forensic-hold intent. The runtime resolves `idFromString(objectId)` and invokes an idempotent quarantine RPC. Quarantine persists before aborting work, clears the object alarm, blocks normal execution with HTTP 423, and requires an explicit signed resume. It never deletes storage.

This is an application-level control, not a Cloudflare account-level “pause
object” API. The exact-object path is:

1. Brolly attributes an emergency to a 64-character Durable Object ID.
2. Brolly sends the owning Worker a 60-second ES256 command scoped to the
   account, project, object ID, and idempotent action ID.
3. The Worker verifies the signature and scope, reconstructs the ID from its
   namespace binding, obtains a stub, and calls the public quarantine RPC.
4. The object durably writes its quarantine state and stopped flag, deletes its
   alarm, and only then aborts any active execution.

While quarantined, the active agent/background run is interrupted and normal
execution or message entry points return HTTP 423 Locked. The object's SQLite
rows, messages, queued records, and history remain stored; other object IDs in
the same namespace continue serving. A signed resume clears the quarantine and
stopped flag and re-arms processing. Clients may need to retry the request that
was interrupted.

Without the signed runtime endpoint, Brolly cannot safely stop one object from
outside it. Disabling the parent Worker is a separate, much broader actuator:
it removes ingress and triggers for every object and user served by that Worker.
The UI must not present that fallback as equivalent to exact-object quarantine.

The runtime must reject account/project mismatches, expired signatures, replayed action IDs, and resume attempts against a forensic hold unless the request explicitly releases that hold.
