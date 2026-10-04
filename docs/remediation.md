# AFL Data Remediation

Version 4 uses explicit competition seasons and coverage contract v4. Fitzroy
6 supplies the matching selectors. Ordinary seasons accept a year or year
string. AFLW's two 2022 seasons require `2022-S6` or `2022-S7`. An ambiguous
AFLW `2022` request returns an error listing those selectors.

## Deployment Order

Version 4.0.0 expanded production through migration `0039`. Version 4.0.1
includes the contract migration `0040` after Tipper 4 and footyBot 0.12 deployed.
Existing AFLW 2022 keeps its internal ID and becomes season six.

1. Publish the candidate through the application repository's normal pipeline.
2. Promote the pinned artefact through cloudflare-infra. Set `SYNC_PAUSED` to
   `true` for the expansion deployment so scheduled writes wait for reader
   updates.
3. Deploy Tipper and other consumers that understand explicit season keys and
   reject active or stale public write markers.
4. Promote the `src/db/migrations/0040_season_key_contract.sql`
   through GitOps after verifying consumers. This transition preserves IDs,
   removes calendar-year uniqueness, and permits season-seven ingestion.
5. Review repair previews, then apply the approved digests through authenticated
   admin operations. Reconcile Bears before historical coaching imports.
6. Restore scheduled writes through GitOps. Verify hourly refresh and daily
   retry observations before accepting production.

Keep the expansion release separate from the contract release. Do not
restore the database automatically after a failed operation. Retain its marker
and checkpoint, diagnose the failure, and resume the same scope.

## Fixture Corrections

Use `POST /mcp/admin/backfill` with an exact `competition`, `season` and
`fixturesOnly: true` to refresh fixture metadata without ingesting player
statistics or lineups. This mode skips weather requests and rebuilds affected
PAV before clearing the public marker. A failed operation must resume with the
same selector and refresh mode.

## Reviewed Identity Operations

`POST /mcp/admin/repair-player-identity` defaults to `dryRun: true`. Provide
`playerIds`, source URLs and capture digests in `evidence`, and evidence for any
conflicting field resolution. The response includes the exact manifest and its
digest. Apply the same request with `dryRun: false` and `manifestDigest`.

The default `kind: "merge"` retains the lowest internal player ID. It reassigns
provider links, collapses duplicate appearances, fills complementary nulls,
records retired-ID redirects, and rebuilds affected PAV atomically per season.
Conflicting values or birth dates block the group until evidence resolves them.
Names only identify candidates for review.

Use `kind: "reassign-appearances"` for contaminated references between two
separate people. Supply exact `matchIds` and verified `providerIdentities`.
The lower ID receives those appearances by default. Set `canonicalId` to another
ID in the verified group when the evidence identifies that person as the target.
The repair digest binds this choice.

Both people retain their historical
identities. This mode creates no retired-ID redirect.

Other appearances and
provider links remain with their existing person. The preview includes the
scope, references, evidence and affected derived rows.

If the verified person has no separate row, choose an unused `canonicalId`
within `playerIds` and include `newPerson` with `firstName`, `surname`,
`dateOfBirth` and source `evidence`. Preview creates nothing. Apply creates the
new person and reassigns the exact appearances atomically. The existing person
and history outside the selected matches remain intact. A failed transaction
retains its marker
without creating a partial identity.

Set `resume: true` with the approved digest after an interruption. A successful
rerun of a completed digest changes nothing. Issued predictions remain intact.

## Field Capability Evidence

`src/sync/stat-field-capabilities.json` records field support observed in 35
exact
provider seasons. Each sample identifies its source URL and content digest.
All-null samples remain unverified. They do not prove that a field is absent.
No sample establishes availability in another era or guarantees every row.

Coverage observations expose the matching capability evidence. Statistics
refresh diagnostics count missing supported fields after preserving known
values.

## Bounded Refresh and Recovery

`POST /mcp/admin/refresh-statistics` previews an exact competition-season or
match scope. Apply its digest, then continue using the persisted operation ID.
Each pass fetches at most 20 due matches, oldest first.
It rebuilds at most 20 affected PAV seasons before clearing the public marker.
Remaining rebuilds retain the marker and require explicit recovery. A failed
match does not
discard successful results for other matches.

Completed matches refresh hourly through 48 hours, daily through day 14, and
once at day 30. Failed fetches retry after increasing delays capped at 24 hours.
Partial responses
preserve known values. Participant removal requires separate completeness
evidence. The ordinary refresh never deletes appearances based on an omission.

`POST /mcp/admin/recalculate-pav` previews one exact competition-season. Apply
its digest to replace derived rows atomically. Missing required season inputs
leave derived values null. Cancelled and live matches do not contribute. The
unbounded `recalculate-all-pav` route returns HTTP 410.

The former `skipPav`
backfill flag now fails validation. Changed PAV inputs queue their own rebuild.

Sync, coaching and Brownlow operations accept `resume: true` for their identical
recorded scope. Admin status identifies the active operation. An expired lease
owner cannot clear a successor's marker or continue writing public inputs.

## Weather and Audit Observations

Weather windows use Melbourne fixture times and elapsed hours across daylight
saving changes, including fixtures played in Perth or Adelaide. Missing samples,
unknown kickoffs and ambiguous repeated hours remain unknown. No process
substitutes noon, zero rainfall or a roof position for missing evidence.

Partial weather retries daily. After the initial failure and three unsuccessful
daily retries, its diagnostic remains unavailable. The authenticated
`retry-weather` operation previews a specific match before scheduling another
attempt. The legacy weather script only captures sources and generates review
artefacts. Production writes require the shared lease.

The hourly audit inspects one competition-season without changing public data.
It rotates through stored seasons and records up to 100 specific findings per
pass. Findings include missing provider links, completed matches without
statistics, failed refreshes and unresolved PAV inputs. They require review.
They do not authorise automatic repairs. Admin status exposes unresolved audit
scopes alongside the refresh and operation diagnostics.

Raw provider inventories remain separate from reviewed source corrections. The
2015 Adelaide-Geelong cancellation overrides the provider's played-draw label.
The 2015 Grand Final retains the stored West Coast home perspective and
transposes scores together. These corrections identify their primary evidence
in `src/sync/source-corrections.ts`.

## Weather and Metadata Corrections

`POST /mcp/admin/refresh-weather` accepts exact `competition`, `season`,
`matchId` and source `evidence`. Review the default dry-run manifest, then apply
its `manifestDigest`. The operation recomputes only that fixture's model window.
A database failure retains the checkpoint and public marker. Resume the same
request with `resume: true`.

Successful reruns are idempotent. Provider failures
leave unknown values with diagnostics and daily retry deadlines.

Kickoff and physical venue changes invalidate cached model weather. Legacy
local-time records without a verified UTC timestamp do not by themselves prove
that the model window was wrong. Review the source context before recomputing.

Migration `0041` corrects `INT` rows previously marked as substitutes. Dedicated
`SUB` rows remain intact. It also preserves old retirement bits in
`legacy_is_retired`. These imported or defaulted bits have no verified source
provenance. `is_retired` therefore remains `NULL` until evidence establishes the
status. Do not infer a player is active from a defaulted zero.
