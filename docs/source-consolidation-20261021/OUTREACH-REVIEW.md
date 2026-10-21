# Outreach donor compatibility review

Reviewed 2026-10-21. Read-only review of pinned Git objects; no Core worktree edits or staging.

- Donor: `7713ecc13c1aaccf7ef6ff4605bd2f5bfb53277a` (`refs/audit/local/outreach-visibility`).
- Parent: `fca52341fd0490e769112071e6b72cfeceaf4e55`.
- Current default base: `309af848f1aa403f6c8e54aa0d22990d4230f063`.
- Files: four test files and `apps/api/src/engagement/engagement.service.ts`.

## Decision

Receive the missing outreach visibility delta only with the send-result correction below and its regression test. Do not receive the original donor uncorrected. The remaining reviewed changes are compatible with the current architecture and policy boundaries. This is a source qualification recommendation, not permission to merge the default branch or deploy.

The default base has no donor outreach-access helpers. Its EngagementService changes since the donor's parent are separate mailbox-authority and paid-extraction controls; preserve those changes during integration. The Meri test file also has additional current-base tests to retain.

The donor deliberately retains `clientId === null` visibility for campaigns. It adds archive/wall checks for associated clients and checks linked meeting/prep/debrief associations and saved prep provenance. That is compatible with `docs/core-meeting-read-authorization-20261017.md`, which requires a product decision before tightening clientless campaign policy. It does not make that policy decision. No donor change alters configuration, default flags, runtime ownership, schemas, infrastructure, IAM, providers, or deployments. The current runtime ownership contract remains API ownership with engagement-api shadow/disabled.

## Finding: preserve actual delivery outcomes after authorization changes (P1)

Pinned donor location: `apps/api/src/engagement/engagement.service.ts:3273-3279`, inside `sendCampaign`.

After `mailSender.sendMail` has already delivered messages, the donor adds client/prep access checks before writing `status`, `sentAt`, and `stats`. A grant revoked (or a client archived/source made inaccessible) during provider latency makes those checks throw. Delivery already happened, but the record remains a draft with no delivery stats. When access returns, the same record can send the same recipients again. The new `clientId`/`meetingId` predicates on this outcome write similarly discard the outcome if an association changes during delivery. This is a regression from the parent, and the legacy route remains enabled when `ENGAGEMENT_VERSIONED_OUTREACH` is false, its repository default.

An isolated probe transpiled the exact pinned `sendCampaign` method with TypeScript and invoked it with a fully mocked provider and transaction. The mock revoked access during `sendMail`. No provider or database was contacted.

| Revision | First send | Outcome writes | Stored state | Retry after access returns |
| --- | ---: | ---: | --- | --- |
| Parent `fca52341` | 1 | 1 | sent, stats present | rejected as not a draft; total sends 1 |
| Donor `7713ecc13` | 1 | 0 | draft, no stats | delivers again; total sends 2 |

### Minimal correction

In the **post-delivery** transaction only, remove `assertOutreachClientsReadable` and `assertOutreachPrepSourcesReadable`. Persist the actual provider outcome using the immutable record identity plus tenant, without mutable association predicates:

```ts
await this.prisma.withTenant(ctx.tenantId, (tx) =>
  tx.outreachRecord.update({
    where: { id, tenantId: ctx.tenantId },
    data: {
      // Keep the existing status/sentAt/stats/campaignSend outcome fields.
    },
    select: { id: true },
  }),
);
```

Keep the donor's pre-send `getOutreachRecord` and association-key checks. Keep `select: { id: true }` on the outcome write. Keep the final `getOutreachRecord` so changed access still prevents returning protected content. That final read may return 404 after revocation, but the trusted send outcome must already be durable. The donor's separate `generateCampaignEmail -> updateCampaign` change does not cause this finding and should remain.

### Required behavioral regression tests

1. Start with a readable draft and one recipient; revoke its client grant inside the mocked successful `mailSender.sendMail`. Assert the result read is denied but one update persists sent status, sentAt, and the successful recipient stats with no sensitive include. Restore access and retry; assert the draft guard rejects and the mail sender remains called exactly once.
2. Repeat with an association change during the provider call. A realistic mock must honor the update's `where` predicate. Assert the exact record's successful outcome remains recorded despite changed client/meeting IDs.

The new donor test file covers list/detail/creation/reassignment/delete/restore visibility but does not exercise this post-delivery outcome path.

## Validation and limits

- Reviewed the full donor service delta, the four test deltas, current-base differences in those paths, the client-wall helper, saved-prep authorization helper, ownership predicates, and relevant policy/runtime-ownership contracts.
- `git diff --check 7713ecc13^ 7713ecc13` passed.
- The isolated parent/donor send probe reproduced the regression above.
- No complete Jest/typecheck run was performed by this read-only reviewer. Receiving owner should run the focused donor tests plus the two outcome regressions after applying the bounded correction.
- No denied or pending tool action remains. No live sends, database mutations, migrations, credential access, or infrastructure changes occurred.
