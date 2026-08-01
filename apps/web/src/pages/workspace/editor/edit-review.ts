import type { WsAssistantEdit } from '../api.js';
import type { WsSectionMeta } from '../types.js';

export interface WorkspaceSectionState {
  sections: string[];
  content: Record<string, string>;
  meta: Record<string, WsSectionMeta>;
}

export interface AppliedWorkspaceEdit {
  edit: WsAssistantEdit;
  target: string;
  destructive: boolean;
}

export interface SkippedWorkspaceEdit {
  edit: WsAssistantEdit;
  reason: string;
}

export interface ApplyWorkspaceEditsResult {
  state: WorkspaceSectionState;
  applied: AppliedWorkspaceEdit[];
  skipped: SkippedWorkspaceEdit[];
  inverseEdits: WsAssistantEdit[];
}

export interface DiffPart {
  value: string;
  type: 'same' | 'added' | 'removed';
}

export function normalizeSectionKey(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function resolveCanonicalSection(
  sections: readonly string[],
  requested: string | null | undefined,
): string | null {
  if (!requested) return null;
  const key = normalizeSectionKey(requested);
  return sections.find((section) => normalizeSectionKey(section) === key) ?? null;
}

export function htmlToReviewText(html: string | null | undefined): string {
  return String(html ?? '')
    .replace(/<\/(p|li|h1|h2|h3|h4|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function tokenize(value: string): string[] {
  return value.match(/\s+|[\p{L}\p{N}_'-]+|[^\s\p{L}\p{N}_'-]/gu) ?? [];
}

/**
 * Bounded LCS word diff. Large sections fall back to a whole before/after pair
 * rather than blocking the editor with quadratic work.
 */
export function diffReviewText(before: string, after: string, maxTokens = 450): DiffPart[] {
  if (before === after) return before ? [{ value: before, type: 'same' }] : [];
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length + right.length > maxTokens) {
    return [
      ...(before ? [{ value: before, type: 'removed' as const }] : []),
      ...(after ? [{ value: after, type: 'added' as const }] : []),
    ];
  }

  const table = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        left[i] === right[j]
          ? 1 + table[i + 1]![j + 1]!
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const parts: DiffPart[] = [];
  const push = (value: string, type: DiffPart['type']) => {
    const previous = parts[parts.length - 1];
    if (previous?.type === type) previous.value += value;
    else parts.push({ value, type });
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push(left[i]!, 'same');
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push(left[i]!, 'removed');
      i += 1;
    } else {
      push(right[j]!, 'added');
      j += 1;
    }
  }
  while (i < left.length) push(left[i++]!, 'removed');
  while (j < right.length) push(right[j++]!, 'added');
  return parts;
}

function uniqueSectionName(sections: readonly string[], requested: string): string {
  const trimmed = requested.replace(/\s+/g, ' ').trim() || 'New section';
  if (!resolveCanonicalSection(sections, trimmed)) return trimmed;
  let suffix = 2;
  while (resolveCanonicalSection(sections, `${trimmed} ${suffix}`)) suffix += 1;
  return `${trimmed} ${suffix}`;
}

export function applyWorkspaceAssistantEdits(
  current: WorkspaceSectionState,
  edits: readonly WsAssistantEdit[],
): ApplyWorkspaceEditsResult {
  let sections = [...current.sections];
  const content = { ...current.content };
  const meta = { ...current.meta };
  const applied: AppliedWorkspaceEdit[] = [];
  const skipped: SkippedWorkspaceEdit[] = [];
  const inverseEdits: WsAssistantEdit[] = [];

  for (const edit of edits) {
    if (edit.op === 'replace_section') {
      const target = resolveCanonicalSection(sections, edit.section);
      if (!target || edit.content == null) {
        skipped.push({ edit, reason: 'The target section no longer exists.' });
        continue;
      }
      inverseEdits.unshift({
        op: 'replace_section',
        section: target,
        content: content[target] ?? '',
        note: 'Undo Meri rewrite',
      });
      content[target] = edit.content;
      meta[target] = { ...(meta[target] ?? {}), status: 'review' };
      applied.push({ edit, target, destructive: false });
      continue;
    }

    if (edit.op === 'remove_section') {
      const target = resolveCanonicalSection(sections, edit.section);
      if (!target) {
        skipped.push({ edit, reason: 'The target section no longer exists.' });
        continue;
      }
      const index = sections.indexOf(target);
      const previous = index > 0 ? sections[index - 1] : undefined;
      inverseEdits.unshift({
        op: 'insert_section',
        name: target,
        afterSection: previous,
        content: content[target] ?? '',
        note: 'Undo Meri section removal',
      });
      sections = sections.filter((section) => section !== target);
      delete content[target];
      delete meta[target];
      applied.push({ edit, target, destructive: true });
      continue;
    }

    if (edit.op === 'insert_section') {
      if (!edit.name || edit.content == null) {
        skipped.push({ edit, reason: 'The proposed section is missing a name or content.' });
        continue;
      }
      const target = uniqueSectionName(sections, edit.name);
      const canonicalAfter = resolveCanonicalSection(sections, edit.afterSection);
      const index = canonicalAfter ? sections.indexOf(canonicalAfter) : -1;
      if (index >= 0) sections.splice(index + 1, 0, target);
      else sections.push(target);
      content[target] = edit.content;
      meta[target] = { status: 'review' };
      inverseEdits.unshift({ op: 'remove_section', section: target, note: 'Undo Meri section insert' });
      applied.push({ edit, target, destructive: false });
    }
  }

  return { state: { sections, content, meta }, applied, skipped, inverseEdits };
}
