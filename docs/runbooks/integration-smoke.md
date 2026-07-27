# Google / Microsoft Integration — Post-Deploy Smoke Checklist

Repeatable manual walk to confirm the Google Workspace and Microsoft 365 engagement
integrations are actually healthy after a deploy touching `apps/api/src/engagement/google`,
`apps/api/src/engagement/microsoft`, or `apps/web/src/pages/settings/IntegrationsPage.tsx`.

Source: §5.4 of `2026-07-26-google-microsoft-integration-remediation-plan.md` (items 1–10),
extended by item 11 from `2026-07-27-google-integration-completion-plan.md` Phase G/K once
Branch G-A (full message body retrieval) shipped, and by items 6/7/7a from
`google-microsoft-integration-remaining-items-plan.md` §3.g (removal-state visibility +
multi-run pagination diagnostics). Run against `https://app.capiro.ai`, signed in as a real
user, unless a step says otherwise.

**Before you start:** run the read-only smoke script first — it costs nothing and tells you
what state every connection is already in before you touch the UI.

```bash
pnpm --filter @capiro/api smoke:integrations -- --tenant=<slug>
```

---

## Checklist

| # | Step | Expected |
|---|---|---|
| 1 | Load `/settings/integrations` | Both Connect buttons **enabled** (Google and Microsoft are both configured today). No "Administrator setup required" text. |
| 2 | Existing Microsoft connection | A **Disconnect** button renders next to Sync now / Realtime. |
| 3 | Click Microsoft Disconnect → read the modal | Copy says "removes Capiro's stored access" and points at myapplications.microsoft.com. It must **not** say "revokes". **Then click Cancel — do not actually disconnect a live mailbox unless Neo says to.** |
| 4 | Google Sync now | Completes; `lastSyncAt` advances; no error banner. |
| 5 | Microsoft Sync now | Completes; `lastSyncAt` advances. |
| 6 | Read-only smoke script | `pnpm --filter @capiro/api smoke:integrations -- --tenant=capiro-internal` prints every connection with `status: connected` and `scopesMatch: true`. **[Added — remaining-items plan §3.g]** For a connection whose last sync stats show `hasMore: true`, the printed `mail.incrementalPageToken`/`mail.labels.ALL.backfillPageToken` (or `calendar.pageToken`) is non-empty and paired with a non-empty `mail.labels.ALL.backfillQuery` (or `calendar.window`) — a saved continuation token without its frozen query/window is a bug. Once a cycle completes (`hasMore: false` on the next run), that same field prints `(none)`. |
| 7 | Trash a Gmail message in the connected mailbox, then Sync now | **[Updated — remaining-items plan §3.g2]** The corresponding `mail_messages` row gets `removed_at` populated and `removed_reason = 'trashed'`; `metadata.googleRemoved = { reason: 'trashed', at: ... }` is still preserved alongside it. The message no longer appears in `GET /api/engagement/mail-threads`'s response for that thread. If you generate outreach with this thread explicitly selected or with auto-suggested email evidence enabled, the message's body does not appear in the evidence sent to the model. Verify all of the above via the diag task, **not** by a direct DB write. |
| 7a | **[Added — remaining-items plan §3.g2]** Restore the message from item 7 back to Inbox, then Sync now | `removed_at` and `removed_reason` clear back to `null` on that same row. The message reappears in `/api/engagement/mail-threads` and becomes selectable/auto-suggestible as outreach evidence again. |
| 8 | Archive a different Gmail message, then Sync now | That row's `metadata.folder` flips `inbox` → `archive`. |
| 9 | Partial-grant rejection | On a **throwaway** Google account, run Connect and untick Gmail read. Expect: redirect back to `/settings/integrations` with a red toast naming the missing scope, and the connection **not** marked connected. **Do not run this against a production user's mailbox.** |
| 10 | Send-to-self, both providers | Send one outreach email to yourself from a Google connection and one from an Outlook connection. Both arrive. This is the only send test — **no bulk or campaign sends.** |
| 11 | **[Added — Branch G-A]** Send yourself a Gmail message with a body clearly longer than a snippet (>500 characters), then Sync now | The corresponding `mail_messages.bodyText` contains the **full** body, not a ~200-character truncation. This is the gate the completion plan's Phase K (K5) requires to pass **before** any scope-justification reply describing full-body access is sent to Google — see `2026-07-27-google-integration-completion-plan.md` §0.1. |

## Safety notes (apply to every run of this checklist)

- `capiro-dev` **is** production — there is no separate prod cluster. Every step above runs
  against real infrastructure.
- Step 3's Cancel and step 9's throwaway-account requirement are not optional conveniences —
  a live disconnect or a partial-grant test against a real account cannot be undone from this
  checklist.
- The read-only smoke script (step 6, and the pre-check above) never decrypts a token, never
  prints ciphertext, and refuses to run with a `--write` flag. It is safe to run at any time,
  including in production, with no side effects.
- If any step fails, do not proceed to steps that assume a healthy connection (e.g. don't run
  step 10's send test against a connection that step 4/5 just showed erroring).
