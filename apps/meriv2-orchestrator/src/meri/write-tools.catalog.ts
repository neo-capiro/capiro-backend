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
 * `PolicyApprovalGate` BEFORE the delegated call (tool-registry.ts). The gate
 * now runs the B2 rules engine (ruleBasedCompliancePolicy — every write => WARN
 * by the seed rule) and, on WARN, consults the B3/B4 ApprovalStore
 * (RepoBackedApprovalStore → apps/api /clio/approvals/check): an unapproved
 * action throws `ApprovalPendingError` and NEVER reaches apps/api; an approved
 * action proceeds. So these tools are fully gated + functional. The full-chat
 * surface (C4) exercises them; the in-editor allowlist remains read-only. Real
 * per-tool BLOCK/PASS compliance rules (B2) + approval policy (TTL/four-eyes,
 * B4) are the domain-input follow-ups, seeded conservatively (all writes WARN).
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
    name: 'confirm_memory',
    description:
      'Re-affirm that a remembered fact is still true and current, resetting its confirmation date. Use when the user verifies something Meri remembers ("yes, that\'s still right"). Pass the memoryItemId from search_memory. Does not change the content.',
    readOnly: false,
  },
  {
    name: 'correct_memory',
    description:
      'Correct a remembered fact: supersede it with new content while preserving the prior version as history. The old memory is retired from recall and the new one takes its place. Use when the user says a remembered fact is wrong or outdated ("actually it\'s X now"). Pass the memoryItemId from search_memory plus the corrected content.',
    readOnly: false,
  },
  {
    name: 'forget_memory',
    description:
      "Forget a remembered fact: stop recalling it immediately and remove it from Meri's memory (a recoverable soft-delete with an audit trail). Use when the user asks Meri to forget something. Pass the memoryItemId from search_memory. Refuses if the item is under a legal hold.",
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
      "Write approved values into a client profile (the Documents/Overview tab fields): name, website, description, productDescription, primaryContactName, primaryContactEmail, primaryContactPhone, sectorTag, issueCodes, uei, cageCode, naicsCodes, pscCodes. You may ALSO append facilities (locations: name, address, city, state, ZIP, congressionalDistrict, employeeCount), capabilities (products/technologies the organization offers: name, type, description, sector), and people (key contacts / personnel: name, title, email, phone, role, lastContact, notes) discovered on the client's website or in filings -- pass them as the facilities[], capabilities[], and people[] arrays. Each facility/capability/person in those arrays is APPENDED (new rows), never used to delete existing ones. Only call this AFTER you have shown the user the proposed values (ideally with a source for each, e.g. from search_public_web / scrape_web_page / LDA filings) and they have approved them. Pass only the fields/rows you are changing. Requires user approval.",
    readOnly: false,
  },
] as const;
