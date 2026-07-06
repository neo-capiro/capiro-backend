import type { DelegatedToolSpec } from '@capiro/meriv2-core';

/**
 * The write (side-effecting) tool catalog the orchestrator registers as
 * DELEGATED tools — same bridge as `delegated-tools.catalog.ts`, but every
 * entry is `readOnly:false`. Names + descriptions are transcribed verbatim
 * from apps/api's SIDE_EFFECTING_TOOLS / TOOL_DEFINITIONS (meri-tools.service.ts)
 * so the model sees identical descriptions on either surface; a drift test
 * (write-tools.catalog.spec.ts) asserts the set matches apps/api's
 * SIDE_EFFECTING_TOOLS exactly.
 *
 * `readOnly:false` means `InMemoryToolRegistry.invoke` runs the
 * `PolicyApprovalGate` BEFORE the delegated call (tool-registry.ts) — with the
 * gate's current `fallback: 'WARN'` policy and no real `ApprovalStore` wired
 * (B3/B4 not built), every invocation of one of these tools throws
 * `ApprovalPendingError` and NEVER reaches apps/api. This is intentional:
 * registering the catalog closes the "write tools aren't in the MeriV2
 * registry" gap without inventing a new approval UX or silently starting to
 * execute real side effects. Nothing on a live surface calls these tools yet
 * (the in-editor allowlist is read-only-only; the full-chat surface does not
 * exist on MeriV2). Wiring a real `ApprovalStore` (B3/B4) or a per-tool
 * `CompliancePolicy` (B2) is the follow-up before any surface may use these.
 */
export const WRITE_DELEGATED_TOOLS: readonly DelegatedToolSpec[] = [
  {
    name: 'create_meeting_brief',
    description:
      'Create and persist a deterministic meeting brief artifact from authorized Capiro data.',
    readOnly: false,
  },
  {
    name: 'draft_policy_memo',
    description: 'Create and persist a policy memo artifact from authorized Capiro client context.',
    readOnly: false,
  },
  {
    name: 'save_note',
    description: 'Save a user-scoped Meri note and optionally an encrypted Capiro meeting note.',
    readOnly: false,
  },
  {
    name: 'send_email',
    description:
      "Send an email via the tenant's connected Microsoft 365 account on behalf of Meri.",
    readOnly: false,
  },
  {
    name: 'reply_email',
    description:
      "Reply to an email thread via the tenant's connected Microsoft 365 account on behalf of Meri.",
    readOnly: false,
  },
  {
    name: 'save_memory',
    description:
      "Persist a durable fact or preference the user shares (a nickname, reporting style, ongoing priority, etc.) to Meri's long-term memory so it is recalled in future conversations. Use this whenever the user asks you to remember something.",
    readOnly: false,
  },
  {
    name: 'create_word',
    description:
      'Generate a downloadable Microsoft Word (.docx) document from a structured spec (title, optional subtitle, and sections with paragraphs, bullets, and tables). Use when the user asks for a Word doc, memo, report, or briefing as a file.',
    readOnly: false,
  },
  {
    name: 'create_excel',
    description:
      'Generate a downloadable Microsoft Excel (.xlsx) workbook from a structured spec (one or more sheets, each with headers and rows). Use when the user asks for a spreadsheet, data export, or table as a file. Numeric-looking cells are stored as numbers.',
    readOnly: false,
  },
  {
    name: 'create_powerpoint',
    description:
      'Generate a downloadable Microsoft PowerPoint (.pptx) deck from a structured spec (title slide plus content slides with bullets and an optional table per slide). Use when the user asks for a slide deck or presentation.',
    readOnly: false,
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a recurring task for Meri to run automatically on a cadence (e.g. a weekly research brief). Requires a name, an instruction prompt, and intervalMinutes (>=60). Scheduled runs are READ-ONLY research only — they cannot send email or write data. Use when the user asks Meri to do something "every week / daily / on a schedule".',
    readOnly: false,
  },
  {
    name: 'cancel_scheduled_task',
    description: 'Cancel (disable) a recurring scheduled Meri task by its id.',
    readOnly: false,
  },
  {
    name: 'create_task',
    description:
      'Create an engagement task/follow-up (title, optional client, due date, description). Requires user approval.',
    readOnly: false,
  },
  {
    name: 'update_task',
    description:
      "Update an engagement task's status, due date, or title (e.g. mark done). Requires user approval.",
    readOnly: false,
  },
  {
    name: 'update_client_profile',
    description:
      'Write approved values into a client profile: scalar fields, and appended facilities, ' +
      'capabilities, and people (key contacts). Requires user approval.',
    readOnly: false,
  },
] as const;
