# LegiWatch complete closeout — merge and rollout runbook

## Release contents

This release completes the remaining LegiWatch correctness and product-contract work:

- filters evaluate the complete paginated board;
- Feed drawers use an authoritative tracked-bill lookup;
- alert deep links use a direct bounded lookup;
- hearing schedule/session failures are shown as failures, never as empty government activity;
- My Sessions uses keyset pagination and exposes watchlist-match/recap state;
- archived hearings reopen their latest accessible session;
- recap saves use the canonical server-side client name and are idempotent;
- recap Documents carry generic source-session provenance;
- client profiles have a real Saved hearing-recaps view;
- long transcripts virtualize after 200 segments;
- the LegiWatch introduction follows the user across devices.

## Migration

One additive apps/api migration is included:

`20260729035000_legiwatch_recap_provenance_and_intro`

It adds:

- `users.legiwatch_intro_seen_at`;
- `engagement_attachments.source_entity_type`;
- `engagement_attachments.source_entity_id`;
- an index for client/source/provenance recap reads.

There is no destructive DDL and no data rewrite.

## Required rollout order

1. Build immutable images for apps/api, apps/intel-api and apps/web from the merge SHA.
2. Run `pnpm --filter @capiro/api exec prisma migrate deploy` against the target database.
3. Verify the new migration is present in `_prisma_migrations` and the provenance index exists.
4. Deploy apps/api.
5. Deploy apps/intel-api.
6. Deploy apps/web.
7. Confirm all three services run the exact merge SHA image.
8. Run the production smoke matrix below.

Do not deploy intel-api or web before the apps/api migration. Their new Saved/indicator reads depend on the provenance columns.

## Ingestion and reconciliation

No legislative, hearing, transcript, bill, or Program Element ingestion rerun is required.

Existing `hearing_recap` Documents created before this release have no trustworthy source-session key. The release deliberately displays them as legacy recaps rather than guessing a hearing association. New and regenerated recaps receive source provenance automatically.

## Production smoke matrix

1. Open LegiWatch with no selected client and filter the all-client Bills board by priority and passage likelihood; allow paging to complete and confirm the result count stabilizes.
2. Open a Feed alert for a bill tracked beyond the first board page and confirm the drawer says Tracked.
3. Open a valid old alert email link and confirm one bounded alert request opens the correct card.
4. Open a deleted alert link and confirm an unavailable warning appears without paging through the feed.
5. Simulate or observe a hearing endpoint failure and confirm the UI says the service is unavailable rather than “No hearings.”
6. Create and end a browser-tab hearing session; verify My Sessions shows its watchlist-match count.
7. Save the recap, repeat the save, and confirm only one current Document exists.
8. Confirm the recap appears under the client profile’s LegiWatch → Saved view and opens the source hearing.
9. Open the archived schedule row and confirm it opens the saved session.
10. Sign in on a second browser and confirm the LegiWatch orientation remains dismissed for the same user.
11. Open a transcript with more than 200 segments and confirm scrolling remains responsive.

## Rollback

Application rollback is safe because the migration is additive. Redeploy the prior api/intel-api/web images. Leave the columns and index in place; do not roll the migration back in production.
