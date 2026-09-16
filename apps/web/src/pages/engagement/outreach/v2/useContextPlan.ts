// Shared logic for the split Context Plan (step 4) + Context Builder (step 5)
// steps. Both operate on the SAME `selected`/`onChange` pair — a click in step
// 5's pool browser must be visible in step 4's Personal Notes panel and vice
// versa — so this cannot live inside either step component; it must be lifted
// above both (called once by the wizard) exactly the way `selected` itself
// already is (`state.contextItems`).
//
// Every function here is lifted verbatim out of the old single "Build
// Context" step (formerly StepContext.tsx) — the split changes WHERE this
// logic is called from, not what it does.
//
// Scope values (SelectedContextItem.scope):
//   'all' | '<recipientKey>' | 'list:<targetKey>' | 'group:<targetKey>'
// List/group scopes are expanded to per-member recipient keys before they're
// sent to the backend (see expandContextItemScopes in targets.ts).
//
// Smart routing: when an item is added, we look at recipients matching
// item.matches. One match that is an INDIVIDUAL target → scope = that key.
// Zero / multi / list-or-group member → scope = 'all'.

import { useMemo, useRef } from 'react';
import { useApi } from '../../../../lib/use-api.js';
import type { OutreachRecipient } from '../../OutreachView.js';
import type { OutreachTarget } from './targets.js';
import { recipientKey, type ContextPoolItem, type SelectedContextItem } from './types.js';

/** One option in the "Applies to" dropdown (individual / list / group). */
export interface ScopeOpt {
  value: string;
  label: string;
  sub?: string;
}

export interface ScopeOptions {
  individuals: ScopeOpt[];
  lists: ScopeOpt[];
  groups: ScopeOpt[];
}

/** Compact secondary line for an individual recipient option/section. */
export function individualSub(r: OutreachRecipient): string {
  if (r.state && r.district) return `${r.state}-${r.district}`;
  return r.office || r.state || r.title || r.email || '';
}

// One plan section per target: individuals, then lists, then groups.
export interface PlanSection {
  targetKey: string;
  scope: string;
  name: string;
  kind: 'individual' | 'list' | 'group';
  sub?: string;
  items: SelectedContextItem[];
}

export function useContextPlan(
  recipients: OutreachRecipient[],
  targets: OutreachTarget[],
  selected: SelectedContextItem[],
  onChange: (next: SelectedContextItem[]) => void,
) {
  const api = useApi();

  const isOn = (id: string) => selected.some((c) => c.id === id);

  // ---- Scope options + sections derived from the structured targets ----
  const scopeOptions = useMemo<ScopeOptions>(() => {
    const individuals: ScopeOpt[] = [];
    const lists: ScopeOpt[] = [];
    const groups: ScopeOpt[] = [];
    for (const t of targets) {
      if (t.type === 'individual') {
        const r = t.recipients[0];
        if (!r) continue;
        individuals.push({
          value: recipientKey(r),
          label: r.name || r.email || 'Recipient',
          sub: individualSub(r),
        });
      } else if (t.type === 'list') {
        lists.push({
          value: `list:${t.key}`,
          label: t.name || 'Untitled list',
          sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'} · applied to each member individually`,
        });
      } else {
        groups.push({
          value: `group:${t.key}`,
          label: t.name || 'Untitled group',
          sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'} · applied to group email`,
        });
      }
    }
    return { individuals, lists, groups };
  }, [targets]);

  // recipientKeys that are their OWN individual target — the only keys smart
  // routing may auto-scope to (a list/group member has no per-member section).
  const individualKeys = useMemo(
    () => new Set(scopeOptions.individuals.map((o) => o.value)),
    [scopeOptions],
  );

  // Smart routing: derive the initial scope for a newly-selected item.
  const deriveScope = (item: ContextPoolItem): 'all' | string => {
    const matches = item.matches;
    if (!matches?.length || recipients.length === 0) return 'all';
    const matched = recipients.filter((r) => {
      const key = recipientKey(r);
      return (
        matches.includes(key) ||
        (r.id && matches.includes(r.id)) ||
        (r.clientId && matches.includes(r.clientId)) ||
        (r.directoryContactId && matches.includes(r.directoryContactId))
      );
    });
    const sole = matched[0];
    if (matched.length === 1 && sole) {
      const key = recipientKey(sole);
      return individualKeys.has(key) ? key : 'all';
    }
    return 'all';
  };

  const matchHint = (item: ContextPoolItem): string | null => {
    const matches = item.matches;
    if (!matches?.length || recipients.length === 0) return null;
    const matched = recipients.filter((r) => {
      const key = recipientKey(r);
      return (
        matches.includes(key) ||
        (r.id && matches.includes(r.id)) ||
        (r.clientId && matches.includes(r.clientId)) ||
        (r.directoryContactId && matches.includes(r.directoryContactId))
      );
    });
    if (matched.length === 0) return null;
    const sole = matched[0];
    if (matched.length === 1 && sole) return sole.name || sole.email || 'matched recipient';
    return `${matched.length} recipients`;
  };

  // Latest `selected` for async callbacks (document text extraction resolves
  // after the user may have toggled other items).
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Client documents have no body until selected; pull the extracted text on
  // demand (txt/csv/pdf/docx/xlsx supported server-side).
  const extractDoc = async (attachmentId: string, itemId: string) => {
    let body: string;
    try {
      const res = await api.post<{ text?: string }>(
        `/api/engagement/attachments/${attachmentId}/extract-text`,
      );
      const text = (res.data?.text ?? '').trim();
      body = text ? text.slice(0, 8000) : '(no extractable text in this document)';
    } catch {
      body = '(could not extract text — supported: .txt, .csv, .pdf, .docx, .xlsx)';
    }
    onChange(selectedRef.current.map((c) => (c.id === itemId ? { ...c, body } : c)));
  };

  const toggle = (item: ContextPoolItem) => {
    if (isOn(item.id)) {
      onChange(selected.filter((c) => c.id !== item.id));
      return;
    }
    const needsExtract = item.kind === 'document' && item.id.startsWith('doc-') && !item.body;
    onChange([
      ...selected,
      {
        ...item,
        scope: deriveScope(item),
        note: '',
        body: needsExtract ? 'Extracting document text…' : item.body,
      },
    ]);
    if (needsExtract) void extractDoc(item.id.slice('doc-'.length), item.id);
  };

  const setNote = (id: string, note: string) =>
    onChange(selected.map((c) => (c.id === id ? { ...c, note } : c)));

  /** Phase 1 §3.b2 — mark a custom note as an instruction (default) or a fact. */
  const setNoteUse = (id: string, noteUse: 'fact' | 'instruction') =>
    onChange(selected.map((c) => (c.id === id ? { ...c, noteUse } : c)));

  const setScope = (id: string, scope: 'all' | string) =>
    onChange(selected.map((c) => (c.id === id ? { ...c, scope } : c)));

  const remove = (id: string) => onChange(selected.filter((c) => c.id !== id));

  const addNoteForScope = (scope: 'all' | string) => {
    const id = `ctx-note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    onChange([
      ...selected,
      {
        id,
        kind: 'note',
        title: scope === 'all' ? 'Shared note' : 'Personalized note',
        body: '',
        note: '',
        scope,
      },
    ]);
    // Callers (the Builder's Custom note tab) need the id to focus the new
    // note's editor immediately on the same surface.
    return id;
  };

  const sharedItems = selected.filter((c) => c.scope === 'all');

  const planSections: PlanSection[] = [];
  for (const t of targets) {
    if (t.type === 'individual') {
      const r = t.recipients[0];
      if (!r) continue;
      const scope = recipientKey(r);
      planSections.push({
        targetKey: t.key,
        scope,
        name: r.name || r.email || 'Recipient',
        kind: 'individual',
        sub: individualSub(r),
        items: selected.filter((c) => c.scope === scope),
      });
    } else {
      const scope = `${t.type}:${t.key}`;
      planSections.push({
        targetKey: t.key,
        scope,
        name: t.name || (t.type === 'list' ? 'Untitled list' : 'Untitled group'),
        kind: t.type,
        sub: `${t.recipients.length} ${t.recipients.length === 1 ? 'contact' : 'contacts'}`,
        items: selected.filter((c) => c.scope === scope),
      });
    }
  }

  // Items scoped to something no section covers — e.g. a draft saved before the
  // grouped scopes existed (scoped to a list member), or a target removed after
  // scoping. Surface them so they're visible and re-routable instead of being
  // silently sent with an invisible scope.
  const routedScopes = new Set<string>(['all', ...planSections.map((s) => s.scope)]);
  const orphanItems = selected.filter((c) => !routedScopes.has(c.scope));

  return {
    // Context Builder (step 5, the pool browser)
    isOn,
    matchHint,
    toggle,
    // Context Plan (step 4, Personal Notes)
    scopeOptions,
    planSections,
    sharedItems,
    orphanItems,
    setNote,
    setNoteUse,
    setScope,
    remove,
    addNoteForScope,
  };
}

export type ContextPlan = ReturnType<typeof useContextPlan>;
