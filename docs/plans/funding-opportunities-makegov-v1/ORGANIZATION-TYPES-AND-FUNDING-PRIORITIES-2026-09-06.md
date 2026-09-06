# Organization types and funding priorities

Base: `e1cfc7471d60b6ecd5ef99fd93bad463f39d4481`.

## Behavior

- Both client editors share a grouped picker with 15 actual organization types and concise labels. Canonical Grants.gov strings remain the storage contract. Other and Unrestricted remain opportunity rules, not selectable client identities.
- Existing legacy selections remain visible for review and survive unrelated edits. Matching ignores them. New clients/imports cannot add them; updates may retain or remove values already stored for that client.
- Optional funding priorities are explicit project phrases in `Client.intakeData.fundingPriorities`. The existing JSON field is reused; no database migration or new provider integration is required. Both UI and API enforce 20 phrases of at most 120 characters. Unrelated intake fields survive editor saves; clearing priorities removes them.
- Live reads and background producers use priorities and capability keywords. Grant and SAM topical matching records whether evidence came from a capability or a funding priority, with one shared topical weight so duplicate inputs cannot inflate scores. Generic phrases and partial-word hits cannot establish substantive fit.
- Grant applicant type and restricted geography remain eligibility context with zero fit weight. The grant fit scale now has a denominator of 100. Unrestricted notices accept a recorded organization category, subject to source requirements; Other or unknown categories require review unless an explicit category matches. Missing identity stays unresolved.
- SAM small-business matching uses the actual Small businesses category; the “other than small businesses” category cannot establish it.
- Forecast priorities are interest evidence, not proof of capability. A concrete priority alone creates a low-confidence Monitor suggestion. Existing stronger forecast evidence remains separate.
- Funding Opportunities, client Opportunities, District Nexus and Meri explanations distinguish funding priorities from capabilities and keep eligibility separate from fit. Meri uses the grant-specific suggestion floor for grant explanations.

## Compatibility and assessment freshness

vNext and legacy share organization metadata, controls, form mapping and explanation helpers. Deploy the API and web together so new priority evidence is labelled consistently. Profile version is v2 and its fingerprint includes normalized priorities.

Live opportunity detail and client discovery recompute using the current profile. Portfolio inbox rows contain saved assessment snapshots; they are labelled Last assessed and provide View current match. Human decisions, owners, notes and tracked workflow states remain preserved. A profile-version bump does not rewrite stored inbox snapshots.

After deployment, run the existing grant, SAM and forecast candidate producers through their normal tenant-scoped dry-run/commit workflow to refresh machine suggestions. Existing human-controlled snapshots may remain historical; the detail action is the current assessment. No production producer run or deployment was performed from this workspace.

## Validation

Regression coverage includes source-only identity rules, applicant mismatch, small-business identity, priority matching and deduplication, whole-phrase boundaries, API create/import/update validation, legacy preservation, profile fingerprints, save/load/clear, live discovery, forecast creation/removal, client relevance and both editor surfaces.

The backend test pass covered 50 suites. Its initial sole failure was the deliberately frozen response-key fixture; that fixture and its constructor were explicitly extended for optional matched-signal source, then the affected suites passed. Frontend tests and web/funding API TypeScript checks passed. Browser visual QA and production deployment remain release checks.
