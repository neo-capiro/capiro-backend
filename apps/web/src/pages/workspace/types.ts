// Workspace engine types — mirror the @capiro/workspace API responses and the
// ws-config-v4 state model (from the prototype). The web app talks to the
// engine at /workspace-api/* via the shared axios client (useApi).

export interface WsAsk {
  amount?: string;
  pb?: string;
  delta?: string;
}

export interface WsLetterhead {
  custom: boolean;
  firmName: string;
  firmAddr: string;
  /** Uploaded branded logo, persisted as a base64 data URL (PNG/JPEG only — SVG
   *  can't embed in the DOCX export, so it's rejected at upload). */
  logoDataUrl?: string;
}

/**
 * A program element linked in Setup → Links & data. We persist the PE reference
 * plus a compact snapshot of its full associated context (mission + financials)
 * so Meri generation can ground the draft in real budget data.
 */
export interface WsLinkedProgramElement {
  peCode: string;
  title: string;
  service?: string | null;
  /** Pre-formatted context block (mission, FY financial history, identifiers). */
  context: string;
}

/**
 * Per-section status (handoff Q-ED-9):
 * - `empty`    — outline only, nothing drafted
 * - `auto`     — auto-populated from structured platform data (budget block etc.)
 * - `draft`    — Meri prose, not yet reviewed
 * - `review`   — needs human sign-off or low-confidence (default for new Meri content)
 * - `done`     — reviewed / accepted
 * - `tailored` — customized for a specific office
 */
export type WsSectionStatus = 'empty' | 'auto' | 'draft' | 'review' | 'done' | 'tailored';

export interface WsSectionMeta {
  status?: WsSectionStatus;
  /** Auto-populated / budget-style section (renders the BudgetBlock, Meri sparkle). */
  smart?: boolean;
  /** Tailored per office. */
  tailor?: boolean;
  /** Live word count for this section. */
  words?: number;
}

/** The persisted engine config blob (ws-config-v4). */
export interface WsConfig {
  industry: string | null;
  product: string | null;
  client: string | null;
  pathways: string[];
  committees: string[];
  personalize: boolean;
  officeAssociated: boolean;
  offices: string[];
  /** Tied to specific client contact(s)? (personalization sub-question) */
  clientAssociated: boolean;
  /** Selected client contacts (names) when clientAssociated. */
  clientPersons: string[];
  coverLetter: boolean;
  selectedTemplate: string | null;
  sections: string[];
  pages: number;
  tone: string;
  /** Setup "key focus or goal for Meri" free-text. */
  toneContext?: string;
  linkedData: string[];
  /** Program elements linked in Setup → Links & data (PE search). */
  linkedProgramElements?: WsLinkedProgramElement[];
  anonymize: boolean;
  letterhead: WsLetterhead;
  /** Per-section body text, keyed by section name. */
  sectionContent?: Record<string, string>;
  /** Per-section status/flags, keyed by section name. */
  sectionMeta?: Record<string, WsSectionMeta>;
  [key: string]: unknown;
}

export type WsDocStatus = 'draft' | 'complete';
export type WsRole = 'editor' | 'reviewer' | 'viewer' | 'commenter';

// ── Collaborators (Collaborate screen) ───────────────────────────────────────
/** The four assignable collaborator roles (the Owner is synthetic, not assignable). */
export type WsAssignableRole = 'editor' | 'reviewer' | 'commenter' | 'viewer';
/** As surfaced in the access list: an assignable role or the synthetic Owner. */
export type WsCollaboratorRole = WsAssignableRole | 'owner';
export type WsCollaboratorStatus = 'active' | 'pending';

/**
 * A row in the "People with access" list. The first row is always the synthetic
 * Owner (role 'owner', isOwner true, non-assignable). Internal teammates carry
 * `subjectId` (Clerk user id, resolved to a name/avatar via useTenantMembers);
 * external invites carry `email` and are `pending`.
 */
export interface WsCollaborator {
  id: string;
  subjectId: string | null;
  email: string | null;
  name: string | null;
  role: WsCollaboratorRole;
  status: WsCollaboratorStatus;
  isOwner: boolean;
}

export interface WsCollaboratorsResponse {
  collaborators: WsCollaborator[];
}

// ── In-app notifications (E-19) ───────────────────────────────────────────────
export type WsNotificationKind = 'collab_invite' | 'collab_accepted' | 'collab_declined';

export interface WsNotification {
  id: string;
  kind: WsNotificationKind;
  draftId: string | null;
  collaboratorId: string | null;
  actorName: string | null;
  draftTitle: string | null;
  role: WsRole | null;
  message: string;
  read: boolean;
  /** True only while a collab_invite is still pending — drives accept/decline. */
  actionable: boolean;
  createdAt: string;
}

export interface WsDocument {
  id: string;
  draftId: string;
  name: string;
  ordinal: number;
  body: { blocks?: WsBlock[] } & Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface WsDraft {
  id: string;
  tenantId: string;
  ownerId: string;
  /** Clerk user id of whoever last edited the draft (null for legacy rows). */
  lastEditedById?: string | null;
  docTitle: string;
  industry: string | null;
  product: string | null;
  client: string | null;
  status: WsDocStatus;
  isPacket: boolean;
  docCount: number;
  ask: WsAsk | 'n/a' | null;
  config: WsConfig;
  createdAt: string;
  updatedAt: string;
  documents: WsDocument[];
}

export interface WsTemplate {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  product: string;
  style: string | null;
  fontFamily: string | null;
  accentColor: string | null;
  meriPrimary: boolean;
  meriSecondary: boolean;
  elements: string[];
  sections: string[];
}

export interface WsComment {
  id: string;
  documentId: string;
  authorId: string;
  role: WsRole;
  quote: string | null;
  anchor: Record<string, unknown> | null;
  body: string;
  resolved: boolean;
  parentId: string | null;
  createdAt: string;
  replies?: WsComment[];
}

/** A platform-data row offered in Setup's Links & data card (INDUSTRY_DATA). */
export interface WsIndustryDatum {
  label: string;
  value: string;
  icon: string;
}

export interface WsProductDefaults {
  product: string;
  personalize: boolean;
  officeAssociated: boolean;
  coverLetter: boolean;
  sections: string[];
  pages: number;
  funding: boolean;
  icon: string;
  description: string;
}

/** A rich block in the document body (section, photo, table, logo). */
export interface WsBlock {
  id: string;
  type: 'section' | 'photo' | 'table' | 'logo';
  title?: string;
  content?: string;
  /** platform-pulled vs custom table. */
  variant?: 'platform' | 'custom';
  /** Provenance label for a pulled-from-platform table (e.g. "PE budget"). */
  source?: string;
  /** Photo/logo image, stored inline as a base64 data URL (PNG/JPEG). */
  src?: string;
  /** Custom table dimensions + per-cell text (E-6). */
  rows?: number;
  cols?: number;
  cells?: string[][];
  [key: string]: unknown;
}

export interface WsContextItem {
  id: string;
  draftId: string;
  kind: 'source' | 'news' | 'free-text';
  payload: Record<string, unknown>;
  createdAt: string;
}

// ── Pre-submission checks (Phase 6b) ─────────────────────────────────────────
export type WsCheckStatus = 'success' | 'notable' | 'critical';

export interface WsCheckResult {
  id: string;
  label: string;
  status: WsCheckStatus;
  detail: string;
  fixable: boolean;
}

// Workspace is gate-less (Ninja D1, 2026-07-12): checks are advisory only, no
// export hard-block. The old empty `gates`/`WsGateResult` vestige was removed.
export interface WsChecksResponse {
  checks: WsCheckResult[];
  score: { passed: number; total: number };
}

// ── "Context used in this draft" panel (Phase 3.3) ───────────────────────────
export interface WsContextUsedItem {
  id: string;
  kind: string;
  label: string;
}
export interface WsContextUsedMemoryFile {
  id: string;
  type: string;
  slug: string;
  label: string;
}
/** As-of-last-generation provenance; null when the draft was never generated. */
export interface WsContextUsed {
  generatedAt: string;
  contextItems: WsContextUsedItem[];
  memoryFiles: WsContextUsedMemoryFile[];
  linkedPeCodes: string[];
}

// ── Version history (Phase 6b) ───────────────────────────────────────────────
export type WsAuthorKind = 'meri' | 'person';

export interface WsDocVersion {
  id: string;
  draftId: string;
  label: string | null;
  authorId: string;
  authorKind: WsAuthorKind;
  snapshot: Record<string, unknown>;
  createdAt: string;
}

// ── Concurrent-edit lock (Phase 6b, Q-ED-2) ──────────────────────────────────
export interface WsLockStatus {
  held: boolean;
  heldByMe: boolean;
  holderId: string | null;
  holderName: string | null;
  acquiredAt: string | null;
  lastHeartbeatAt: string | null;
  holderInactive: boolean;
  requestedById: string | null;
  requestedByName: string | null;
  requestedAt: string | null;
  hasIncomingRequest: boolean;
}
