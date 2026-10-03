# Coaching Release Operations

Version 3.8.0 consumes published fitzroy 5.0.0. It introduces additive coaching
storage, native input revisions and repeatable venue reference seeds.
Deploy the reviewed Worker through cloudflare-infra before historical writes.
Worker deployment does not authorise historical identity repair or backfill.

## Release Verification

Require passing application CI, schema parity and completed R2 publication for
the exact commit. Promote that SHA through `promote-worker.yml`, review the release
pins and plan, merge, then dispatch `apply-prod` for `targets/afl-mcp`.
Do not run a direct production Wrangler deployment.

After apply, verify the Worker release annotation, required bindings, cron,
health and migration history. Read coaching relations through the native
read-only contract and confirm a scheduled sync completes. Compare aggregate
integrity counts with the pre-release checkpoint. Historical coaching coverage
can remain incomplete after a successful deployment.

## Historical Identity Repair

Obtain separate authorization for historical writes. Capture a D1 recovery
checkpoint and review affected identities and dependent references first.
Use the existing protected admin token through the operator's credential
mechanism. Never store the token in scripts, logs or release records.

Authenticated `POST /mcp/admin/reconcile-bears` defaults to preview mode:

```json
{ "dryRun": true }
```

Review the returned match, lineup, player-stat, PAV and coaching counts.
Check conflicting participant keys before issuing the same request with
`dryRun: false`. The operation shares the sync lease. Retry lease contention
after the current writer finishes. Match IDs and provider mappings stay stable.

Participant changes invalidate current Tipper predictions and game-ID mappings
through the fixture trigger. Issued `tipper_predictions` retain their original
identity snapshot. Source refresh rebuilds current mappings. Repeat the preview
after repair and require zero remaining historical Lions references in scope.
Verify post-1996 Lions rows and Fitzroy rows remain unchanged.

## Historical Coaching Backfill

Repair Bears identity before historical coaching writes. Preview one AFLM
season at a time, from 1990 onward:

```json
{ "fromYear": 1996, "toYear": 1996, "source": "afl-tables", "dryRun": true }
```

Use authenticated `POST /mcp/admin/backfill-coaches`. A preview examines one
bounded source batch and does not persist continuation state. After reviewing
the scope and obtaining write authorization, repeat with `dryRun: false`.

Requests fetch at most five coach profiles. Continue the same season while the
response has `pending: true`. Check failures and unresolved joins before moving
to the next season. Persisted checkpoints retain evidence and failed-page
retries. A thrown write failure retains the checkpoint for another attempt.

Only a complete authoritative season can remove stale canonical assignments.
Partial results retain prior facts. FootyWire season-wide coaching remains
unsupported. Unknown credits remain absent. Use private admin status and bounded
schema coverage to audit expected participant assignments, actual assignments,
failed scopes, conflicts and unresolved joins. Never infer complete historical
coverage from the source's supported year range.

## Interrupted Writes and Recovery

Native readers reject active and stale `public_input_revision.in_progress`
markers. Check `sync_lease`, private status, sync logs and the relevant coaching
checkpoint before recovery. Confirm the former writer has stopped, identify
which writes committed, and reconcile the interrupted operation under the lease.
Do not clear a marker solely because it is old. Any exceptional marker repair
requires reviewed production write authorization and a recorded outcome.

If apply fails after D1 migrations succeed, retain the additive schema and fix
the failing step. Rerun the same pinned release. A Worker rollback requires a
reviewed GitOps promotion and compatibility verification against the expanded
schema. Do not reverse successful migrations or discard committed facts.

## Migration Baseline Follow-Up

Complete the initial release before squashing. Verify no pending migrations and
compare a production schema-only export with local replay. Reserve a quiet
schema-change window and record a recovery checkpoint.

Ship a reviewed adoption migration that registers the future baseline name in
`d1_migrations` through the existing GitOps pipeline. Verify its application,
then tag the pre-baseline commit. A second release replaces the active history
with the verified baseline schema and reference seeds. Fresh databases execute
the baseline. Adopted databases skip it. Keep historical incident repairs in
Git history, and link their documentation to the pre-baseline tag.

Test both paths on real local D1 and require schema parity and valid foreign
keys before either promotion. Retain the current history if adoption gates fail.
Never manually edit the production migration ledger to bypass the pipeline.
