# Outreach group recipients and attachments

## Confirmed failure

The September 15 campaign had two group targets containing three and two people.
Both generated artifacts had `audienceKind: group` but their recipient snapshots
contained only the first person's email and no `groupMembers`. The two resulting
delivery envelopes each contained one To recipient. The provider accepted those
two messages. No attachments were selected in the saved campaign or send intent.

Classic outreach generated a group from `target.recipients[0]`, while the legacy
send projection separately preserved the complete group. Versioned sending uses
the generated artifact snapshot, so the full group never reached that path.

## Fix

- Generation retains every group member and uses distinct group result IDs even
  when groups share a first member. Individual/list snapshots retain the resolved
  Cc/Bcc addresses.
- Real group sends reject missing or invalid membership instead of falling back
  to the first person's address. Existing malformed artifacts must be replaced
  with a newly created group draft; changing their existing version's text alone
  does not repair its recipient snapshot.
- Both Send controls respect the full preflight. A draft that is still saving or
  awaiting verification cannot silently disappear from a send-all operation.
- Outreach uses the shared filename-based MIME detector when a browser provides
  no type for a supported file.
- Pending uploads block advancing and sending; failed uploads remain visible
  until retried or explicitly removed. Every confirmed selected attachment ID is
  submitted with the send intent.

## Regression evidence

- Real wizard generation requests retain the three-person and two-person groups.
- Intent creation stores the complete group envelopes and attachment manifests.
- The actual worker passes both envelopes and exact file bytes to the provider.
- Outlook draft requests and Gmail MIME preserve multiple To/Cc/Bcc recipients
  and two attachment payloads.
- Wizard tests cover empty MIME types, attachment IDs in the send request,
  concurrent uploads, and persistent upload-failure handling.
- Existing attachment integrity, ambiguous delivery, and duplicate-send tests
  remain part of the focused regression run.

Production diagnostics were read-only. No customer campaign was resent or
changed, and no customer-facing email was sent during verification.
