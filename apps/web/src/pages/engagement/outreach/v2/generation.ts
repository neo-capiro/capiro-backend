// Outreach 2.0 — generation target model for Generate & Review (board step 10).
//
// Drafts in WizardV2State.generatedEmails are keyed by a GenerationTargetKey
// (per the frozen data-model doc §4), NOT by a flat recipientKey:
//   individual:<recipientKey>          one personalized draft
//   list:<audienceId>:<recipientKey>   one draft PER MEMBER of a list
//   group:<audienceId>                 ONE shared draft for the whole group
//
// (The doc also models a list-wide `list:<aid>` draft; the board personalizes
// every list member instead, so we materialize per-member drafts and let the
// edit-propagation banner copy one member's edit across the list. `appliesTo`
// is derived from the key prefix, so the stored draft value is unchanged.)
//
// Generation still flows through the unchanged POST /outreach/generate-batch
// (flat recipients[] → results keyed by recipientId). This module maps the
// entity model onto that flat contract: individuals/list-members send
// themselves; a group sends a single representative whose result becomes the
// one shared group draft. At send, projectDraftsForSend() fans the per-target
// drafts back to one flat {recipientId,subject,body} per recipient.

import type { OutreachRecipient } from '../../OutreachView.js';
import { recipientKey, type SelectedContextItem } from './types.js';
import type { OutreachTarget, TargetType } from './targets.js';

/**
 * Stable signature of the inputs that drive draft generation — the selected
 * context items (id/scope/note + body length, so edits and doc-extraction
 * register), the template, tone, and direction. Generate & Review compares the
 * live signature against the one captured at the last full generation to know
 * when drafts are stale (the "context changed — regenerate" banner).
 */
export function genInputSignature(input: {
  contextItems: SelectedContextItem[];
  templateId: string | null;
  tone: string;
  direction: string | null;
}): string {
  return JSON.stringify({
    ctx: input.contextItems.map((c) => [c.id, c.scope, c.note ?? '', (c.body ?? '').length]),
    template: input.templateId,
    tone: input.tone,
    direction: input.direction,
  });
}

export type GenerationAppliesTo = 'individual' | 'member' | 'group';

/**
 * A stable audience id for a list/group target. Saved audiences carry an
 * `audienceId`; campaign-local ones fall back to the (uuid) target key so the
 * generation keys are always well-formed and stable within a session. Both are
 * colon-free, which keeps `list:<aid>:<recipientKey>` parseable even though a
 * recipientKey may itself contain colons.
 */
export function audienceIdOf(t: OutreachTarget): string {
  return t.audienceId ?? t.key;
}

/** One editable draft "slot" — the unit the rail shows and generation fills. */
export interface GenSlot {
  genKey: string;
  appliesTo: GenerationAppliesTo;
  /**
   * Recipient(s) POSTed to generate-batch to produce this draft. Individuals
   * and list members send themselves; a group sends one representative.
   */
  genRecipients: OutreachRecipient[];
  /** The recipientId the backend result carries for genRecipients[0]. */
  resultId: string;
  /** Extra prompt context — a group passes its full member listing. */
  additionalContext?: string;
}

/** A selectable row in the left rail (an individual, a list member, or a group). */
export interface RailSlot {
  genKey: string;
  appliesTo: GenerationAppliesTo;
  name: string;
  sub: string;
  recipient: OutreachRecipient;
}

/** A rail card grouping its slots (individual: 1, list: N members, group: 1). */
export interface RailEntity {
  kind: TargetType;
  target: OutreachTarget;
  name: string;
  audienceId?: string;
  members: RailSlot[];
}

export interface SendDraft {
  recipientId: string;
  subject: string;
  body: string;
}

function contextLine(r: OutreachRecipient): string {
  return r.office || r.state || r.title || '';
}

function groupAdditionalContext(name: string, members: OutreachRecipient[]): string {
  const lines = members.map((m) => {
    const where = contextLine(m);
    return `- ${m.name || m.email || 'Recipient'}${where ? ` (${where})` : ''}`;
  });
  return `This is ONE shared email addressed together to the group "${name}". Write a single message appropriate for all of these recipients:\n${lines.join('\n')}`;
}

/** Build the rail entities + the flat slot list (the unit of generation). */
export function buildGenerationModel(targets: OutreachTarget[]): {
  entities: RailEntity[];
  slots: GenSlot[];
} {
  const entities: RailEntity[] = [];
  const slots: GenSlot[] = [];

  for (const t of targets) {
    if (t.type === 'individual') {
      const r = t.recipients[0];
      if (!r) continue;
      const genKey = `individual:${recipientKey(r)}`;
      slots.push({
        genKey,
        appliesTo: 'individual',
        genRecipients: [r],
        resultId: recipientKey(r),
      });
      entities.push({
        kind: 'individual',
        target: t,
        name: r.name || r.email || 'Recipient',
        members: [
          {
            genKey,
            appliesTo: 'individual',
            name: r.name || r.email || 'Recipient',
            sub: contextLine(r),
            recipient: r,
          },
        ],
      });
    } else if (t.type === 'list') {
      const aid = audienceIdOf(t);
      const members: RailSlot[] = [];
      for (const m of t.recipients) {
        const genKey = `list:${aid}:${recipientKey(m)}`;
        slots.push({ genKey, appliesTo: 'member', genRecipients: [m], resultId: recipientKey(m) });
        members.push({
          genKey,
          appliesTo: 'member',
          name: m.name || m.email || 'Recipient',
          sub: contextLine(m),
          recipient: m,
        });
      }
      if (members.length === 0) continue;
      entities.push({
        kind: 'list',
        target: t,
        name: t.name || 'Untitled list',
        audienceId: aid,
        members,
      });
    } else {
      // group — ONE shared draft for the whole set.
      const aid = audienceIdOf(t);
      const rep = t.recipients[0];
      if (!rep) continue;
      const genKey = `group:${aid}`;
      slots.push({
        genKey,
        appliesTo: 'group',
        genRecipients: [rep],
        resultId: recipientKey(rep),
        additionalContext: groupAdditionalContext(t.name || 'Group', t.recipients),
      });
      const count = t.recipients.length;
      entities.push({
        kind: 'group',
        target: t,
        name: t.name || 'Untitled group',
        audienceId: aid,
        members: [
          {
            genKey,
            appliesTo: 'group',
            name: t.name || 'Untitled group',
            sub: `${count} ${count === 1 ? 'contact' : 'contacts'} · 1 email`,
            recipient: rep,
          },
        ],
      });
    }
  }

  return { entities, slots };
}

/** Extract the audience id from a `list:<aid>:<recipientKey>` member key. */
export function listAidFromKey(genKey: string): string | null {
  if (!genKey.startsWith('list:')) return null;
  const rest = genKey.slice('list:'.length);
  const idx = rest.indexOf(':'); // aid is colon-free, so this is the aid boundary
  return idx === -1 ? null : rest.slice(0, idx);
}

/**
 * Project per-target drafts to the flat {recipientId,subject,body} send-batch
 * contract. Individuals/list-members emit one draft each (keyed by recipientKey).
 * A GROUP emits ONE draft keyed to its single representative `group:<targetKey>`
 * — matching flattenTargets' group representative — so the group sends as one
 * email with all members in To. Drafts with no subject AND no body are skipped.
 *
 * @deprecated Phase 0 (§3.g2) — LEGACY path only, reached when the server reports
 * `versionedOutreachEnabled: false`. It projects raw TEXT, which is exactly the
 * bypass Phase 0 closes; the versioned path uses projectVersionIdsForSend() in
 * send-intent.ts, which emits version ids and no content. Retained so the flag
 * can be switched off without regressing. Do not add new callers.
 */
export function projectDraftsForSend(
  targets: OutreachTarget[],
  generated: Record<string, { subject: string; body: string; status: string }>,
): SendDraft[] {
  const out: SendDraft[] = [];
  const seen = new Set<string>();
  const push = (
    r: OutreachRecipient,
    draft?: { subject: string; body: string; status: string },
  ) => {
    if (!draft) return;
    // `status === 'error'` is the AUTHORITATIVE unsendable signal — set
    // unambiguously by the backend from the moment it responds (both whole-POST
    // failures and same-batch per-recipient failures now carry it, via
    // partitionGenerationResults below). It only becomes sendable once the user
    // edits it (→ 'edited') or a regenerate succeeds (→ 'ready').
    if (draft.status === 'error') return;
    // Secondary defense-in-depth: a user could blank a draft by hand without
    // changing its status. Kept deliberately, but no longer the primary gate.
    if (!draft.subject?.trim() && !draft.body?.trim()) return;
    const id = recipientKey(r);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ recipientId: id, subject: draft.subject, body: draft.body });
  };

  const handle = (t: OutreachTarget) => {
    if (t.type === 'individual') {
      const r = t.recipients[0];
      if (r) push(r, generated[`individual:${recipientKey(r)}`]);
    } else if (t.type === 'list') {
      const aid = audienceIdOf(t);
      for (const m of t.recipients) push(m, generated[`list:${aid}:${recipientKey(m)}`]);
    } else {
      // GROUP — one draft for the whole group, keyed to its representative
      // `group:<targetKey>` (the same id flattenTargets emits), so the group
      // sends as a single email to all members.
      const aid = audienceIdOf(t);
      const shared = generated[`group:${aid}`];
      if (shared && shared.status !== 'error' && (shared.subject?.trim() || shared.body?.trim())) {
        const id = `group:${t.key}`;
        if (!seen.has(id)) {
          seen.add(id);
          out.push({ recipientId: id, subject: shared.subject, body: shared.body });
        }
      }
    }
  };

  // Order doesn't affect groups now (they emit one draft under a dedicated
  // `group:<key>` id), but individuals/lists still dedupe by recipientKey.
  for (const t of targets) if (t.type === 'group') handle(t);
  for (const t of targets) if (t.type === 'list') handle(t);
  for (const t of targets) if (t.type === 'individual') handle(t);
  return out;
}

// ── Batch-generation result partitioning (W0.2) ──────────────────────────────

/** A per-recipient result from POST /outreach/generate-batch. `status` is the
 *  authoritative sendability signal — a same-batch failure comes back with
 *  empty subject/body tagged 'error' (not silently 'ready'). */
export interface BatchDraftResult {
  recipientId: string;
  subject: string;
  body: string;
  /**
   * 'ready' = sendable; 'error' = generation failed; 'held' = the post-hoc
   * grounding auditor HELD this draft (only under MERI_AUDITOR_MODE=enforce).
   * A held draft is NOT sendable — it is bucketed with failures below so it can
   * never be auto-sent while a grounding finding is unresolved.
   */
  status: 'ready' | 'error' | 'held';
  error?: string;
  /** Internal note for the lobbyist only — never sent to the recipient. */
  contextNote?: string;
}

/**
 * Partition a chunk's slots against the backend results by resultId.
 *
 * Phase 0 (§3.g2) changed the HELD case. A held draft is real content that a
 * reviewer must read; routing it to `failedGenKeys` made the wizard overwrite it
 * with a "generation failed" placeholder, destroying the very text under review.
 * Held results now come back in `heldDrafts` — kept verbatim, and still NOT
 * sendable. Genuine failures (and dropped slots) remain in `failedGenKeys`.
 */
export function partitionGenerationResults(
  slots: Array<{ genKey: string; resultId: string }>,
  results: BatchDraftResult[],
): {
  drafts: Array<{ genKey: string; subject: string; body: string }>;
  /** Held content, preserved. Non-sendable, but shown to the user for review. */
  heldDrafts: Array<{ genKey: string; subject: string; body: string; contextNote?: string }>;
  failedGenKeys: string[];
  /** Convenience: the genKeys in `heldDrafts`. */
  heldGenKeys: string[];
} {
  const byId = new Map(results.map((r) => [r.recipientId, r]));
  const drafts: Array<{ genKey: string; subject: string; body: string }> = [];
  const heldDrafts: Array<{
    genKey: string;
    subject: string;
    body: string;
    contextNote?: string;
  }> = [];
  const failedGenKeys: string[] = [];
  for (const s of slots) {
    const r = byId.get(s.resultId);
    if (!r) {
      // The backend dropped this slot: a genuine failure, no content exists.
      failedGenKeys.push(s.genKey);
      continue;
    }
    if (r.status === 'ready') {
      drafts.push({ genKey: s.genKey, subject: r.subject, body: r.body });
    } else if (r.status === 'held') {
      heldDrafts.push({
        genKey: s.genKey,
        subject: r.subject,
        body: r.body,
        ...(r.contextNote ? { contextNote: r.contextNote } : {}),
      });
    } else {
      failedGenKeys.push(s.genKey);
    }
  }
  return { drafts, heldDrafts, failedGenKeys, heldGenKeys: heldDrafts.map((d) => d.genKey) };
}

// ── Generate task construction (shared by sync POST + async job submit) ───────

/** One unit of generation work: the recipients POSTed together, the slots whose
 *  drafts that POST produces, and the group flag/context when applicable. */
export interface GenerateTask {
  recipients: OutreachRecipient[];
  chunkSlots: GenSlot[];
  additionalContext?: string;
  audienceKind?: 'group';
}

/**
 * Split slots into the exact task list the wizard sends: unique flat
 * (individual/list-member) recipients chunked at `batchMax` (one POST each, the
 * server's per-batch cap), plus one task per group slot carrying its member
 * listing + the group flag. Extracted so the synchronous generate-batch path and
 * the async job-submit path build IDENTICAL work units — no drift.
 */
export function buildGenerateTasks(slots: GenSlot[], batchMax: number): GenerateTask[] {
  const tasks: GenerateTask[] = [];
  const flatSlots = slots.filter((s) => s.appliesTo !== 'group');
  if (flatSlots.length) {
    const uniqueRecipients = new Map<string, OutreachRecipient>();
    for (const s of flatSlots) {
      const r = s.genRecipients[0];
      if (r && !uniqueRecipients.has(s.resultId)) uniqueRecipients.set(s.resultId, r);
    }
    const uniqueEntries = [...uniqueRecipients.entries()];
    for (let i = 0; i < uniqueEntries.length; i += batchMax) {
      const chunk = uniqueEntries.slice(i, i + batchMax);
      const chunkIds = new Set(chunk.map(([id]) => id));
      tasks.push({
        recipients: chunk.map(([, r]) => r),
        chunkSlots: flatSlots.filter((s) => chunkIds.has(s.resultId)),
      });
    }
  }
  for (const slot of slots.filter((s) => s.appliesTo === 'group')) {
    tasks.push({
      recipients: slot.genRecipients,
      chunkSlots: [slot],
      additionalContext: slot.additionalContext,
      audienceKind: 'group',
    });
  }
  return tasks;
}

// ── Draft version history (W2.6 "Improve"/Revert) ────────────────────────────

export interface DraftVersion {
  subject: string;
  body: string;
}

interface DraftWithHistory {
  subject: string;
  body: string;
  history?: DraftVersion[];
}

/**
 * Snapshot the current draft onto its history before an "Improve" overwrites it,
 * keeping only the newest 2 versions so a user can back out a bad rewrite without
 * unbounded growth. Returns the new history array (undefined if there is nothing
 * to snapshot).
 */
export function appendDraftHistory(
  prior: DraftWithHistory | undefined,
): DraftVersion[] | undefined {
  if (!prior) return undefined;
  return [...(prior.history ?? []), { subject: prior.subject, body: prior.body }].slice(-2);
}

/**
 * Pop the newest history entry back into the draft (Revert). Returns the restored
 * subject/body + the remaining history, or null when there is nothing to revert.
 */
export function revertDraftHistory(
  draft: DraftWithHistory,
): { subject: string; body: string; history: DraftVersion[] } | null {
  if (!draft.history?.length) return null;
  const history = [...draft.history];
  const restored = history.pop()!;
  return { subject: restored.subject, body: restored.body, history };
}
