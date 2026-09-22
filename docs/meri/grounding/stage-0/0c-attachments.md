# Attachment content state

Under evidence-accuracy enforcement for the `chat` surface, Meri receives an explicit content state anywhere attachment metadata reaches the model:

- `ready`: readable extracted text is available.
- `partial`: readable text is available, but a page, character, or extraction cap applies.
- `metadata_only`: the file is known, but no readable extracted text is available (including images and scanned documents).
- `failed`: extraction threw or otherwise failed; the limitation preserves the user-readable reason.
- `pending`: extraction has not completed.
- `unsupported`: the format or contents cannot be extracted.

Every state also has `readable`, `extractedChars`, and a nullable `limitation`. Empty text is never readable, regardless of the stored status. The Hermes attachment tool adds these fields and a prohibition against describing unread contents. Current-turn Hermes attachment lines include the state and limitation. Legacy callers keep their existing payloads and strings while the flag is off.

## Persistence and retry

Enforced uploads persist scanned, unsupported, and failed extraction outcomes together with original bytes. This makes the limitation fetchable and permits one recovery attempt. A retry is permitted only for an unreadable attachment with stored bytes; the row reason is marked `retry_attempted`, making subsequent requests deterministic no-ops. A successful retry replaces status, extracted text, pages, and limitation. A failed retry remains explicitly failed.

Validation failures that occur before extraction retain the legacy rejection shape because untrusted or unsupported uploads must not be made durable.

## Prior-turn manifest and duplicate names

Under `chat` enforcement, the Hermes input includes up to 20 authorized earlier attachments, newest first, without replaying text or bytes:

`attachment_id=<id> filename=<name> turn=<n> state=<content-state> chars=<extracted characters>`

The model is instructed to fetch by id with `meri_fetch_attachment` rather than ask for a re-upload. Duplicate filenames are marked `duplicate name — distinguish by turn/date`. Reference resolution prefers exact filename, then case-insensitive filename, then filename stem. Multiple matches return candidate ids, filenames, turns, upload times, and states; an explicit “latest” or “most recent” request may select the newest candidate. The Hermes broker contract accepts attachment ids only, so filename resolution stays outside the broker and the manifest supplies the disambiguation.

The broker attachment read remains scoped by tenant and actor, but it does not currently assert that the attachment's source message belongs to the run's conversation. The manifest query does enforce tenant, user, conversation, and user-message scope; the broker conversation-binding gap remains a follow-up boundary issue.

## Follow-up scope

T8b adds a prior-turn attachment manifest and duplicate-filename disambiguation. This task covers current-turn metadata, persisted extraction outcomes, and bounded retry only.
