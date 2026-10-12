# Frontend handoff through parent

Sender draft PR2393: reviewed repair source `14d66227c4898ad3aaa7e46ec054c5b2c325c5fe`.
`GET /api/engagement/mail/mailboxes` returns only id/provider/accountEmail/displayName,
local `availability:available` and `signaturePolicy:actor`. Pass the selected UUID as
`senderConnectionId` to existing `POST /api/engagement/mail/send`. Explicit selection
never falls back; replies must keep their originating mailbox. Success reports the
same sender identity plus signature policy/applied flag. Both 503
`MAIL_SEND_OUTCOME_UNKNOWN` and `MAIL_SEND_RECEIPT_UNAVAILABLE` are `retryable:false`;
lost/mismatched receipts require Sent Items reconciliation, never automatic resend.
Actor/tenant changes invalidate the picker; local availability does not certify OAuth.
Test B selection, unavailable/foreign B, A-thread/B-sender refusal, actor signature,
attachment refusal, and unknown/receipt-unavailable results.

Facility draft PR2394: reviewed exact head `5d075af9b376cd3ed67256b5c38e4a2a2130a51d`.
Use facility read field `geocodeCandidateRevision` as opaque `expectedRevision` in
`POST /api/clients/:clientId/facilities/:id/geocode-candidate/reviewed` with
`candidateIndex`. A 409 means refresh and review the new candidates. A missing
revision or unsupported reviewed route must not fall back to the old unreviewed
route. Invalidate cached review on client/session change; prevent duplicate UI actions.
The revision is semantic, not a monotonic sequence.

Draft source qualification only: sender independent168/168; facility96/96 +4/4
lifecycle. Native Prisma/PostgreSQL/RLS concurrency, browser/authenticated deployment
and provider acceptance remain unrun. Native downloads are HTTP403-blocked; no
bypass or live DB/provider use. Parent owns relay; no frontend files were edited.
