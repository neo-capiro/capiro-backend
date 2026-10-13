import { classifyVoteResult } from '@capiro/shared';
import type { DossierSeverity, LegislativeMilestone } from './bill-dossier.types.js';
import { toIso, capitalize, byDateDesc } from './bill-dossier-presentation.js';

export interface ActionMilestoneSource {
  id: string;
  date: Date;
  text: string;
  type: string | null;
  chamber: string | null;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export function isPassageActionText(text: string): boolean {
  const t = text.toLowerCase();
  if (/motion to (recommit|reconsider|table)|cloture|previous question/.test(t)) return false;
  return /\bon passage\b.*\b(pass|agree)|passed\/agreed to in (the )?(house|senate)|\bpassed (the )?(house|senate)\b|passage of the bill|third reading.*\b(pass|agree)/.test(
    t,
  );
}

export function readableChamber(value: string | null | undefined): string | null {
  if (!value) return null;
  if (/house|lower/i.test(value)) return /lower/i.test(value) ? 'Lower chamber' : 'House';
  if (/senate|upper/i.test(value)) return /upper/i.test(value) ? 'Upper chamber' : 'Senate';
  return capitalize(value);
}

export function chamberFromAction(text: string, fallback: string | null): string | null {
  if (/\bhouse\b/i.test(text)) return 'House';
  if (/\bsenate\b/i.test(text)) return 'Senate';
  return readableChamber(fallback);
}

export function actionOutcome(text: string): { label: string; sev: DossierSeverity } | null {
  const result = classifyVoteResult(text);
  if (result === 'fail') {
    return { label: /\breject(?:ed|ion)\b/i.test(text) ? 'Rejected' : 'Failed', sev: 'critical' };
  }
  if (result === 'pass') {
    if (/\bpassed\b/i.test(text)) return { label: 'Passed', sev: 'success' };
    if (/\badopted\b/i.test(text)) return { label: 'Adopted', sev: 'success' };
    return { label: 'Agreed', sev: 'success' };
  }
  return null;
}

export function readableActionType(type: string | null, text: string): string | null {
  if (/received in (the )?senate/i.test(text)) return 'Senate receipt';
  if (/received in (the )?house/i.test(text)) return 'House receipt';
  switch ((type ?? '').toLowerCase()) {
    case 'introreferral':
      return 'Chamber referral';
    case 'floor':
      return 'Floor action';
    case 'committee':
      return 'Committee action';
    case 'president':
      return 'Presidential action';
    default: {
      const clean = (type ?? '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim();
      return clean ? capitalize(clean) : null;
    }
  }
}

export function passageDetail(text: string): string {
  const parts = ['On passage'];
  const tally = text.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b/);
  if (tally) parts.push(`${tally[1]}–${tally[2]}`);
  const roll = text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i);
  if (roll) parts.push(`Roll no. ${roll[1]}`);
  return parts.join(' · ');
}

export function actionSemanticKey(action: ActionMilestoneSource): string {
  const day = action.date.toISOString().slice(0, 10);
  if (isPassageActionText(action.text)) {
    const chamber = chamberFromAction(action.text, action.chamber) ?? '';
    const tally = action.text.match(/\b(\d{1,3})\s*[-–]\s*(\d{1,3})\b/);
    if (tally) {
      // Tally is shared by Congress.gov's detailed and summary rows even when
      // only one of them carries the roll number.
      return `${day}|passage:${chamber.toLowerCase()}:tally:${tally[1]}-${tally[2]}`;
    }
    const roll = action.text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i)?.[1];
    return `${day}|passage:${chamber.toLowerCase()}:roll:${roll ?? 'unknown'}`;
  }
  const roll = action.text.match(/roll\s+(?:no\.?|number)\s*(\d+)/i)?.[1];
  if (roll) {
    // Roll numbers are chamber-scoped; House and Senate can use the same one.
    const chamber = chamberFromAction(action.text, action.chamber) ?? '';
    return `${day}|roll:${chamber.toLowerCase()}:${roll}`;
  }
  if (/received in (the )?(house|senate)/i.test(action.text)) {
    return `${day}|receipt:${chamberFromAction(action.text, action.chamber)?.toLowerCase() ?? ''}`;
  }
  const normalized = action.text
    .replace(/^passed\/agreed to in (the )?(house|senate):\s*/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return `${day}|${normalized}`;
}

export function buildActionMilestones(
  actions: ActionMilestoneSource[],
  limit: number,
): LegislativeMilestone[] {
  const grouped = new Map<string, LegislativeMilestone>();
  for (const action of actions) {
    const key = actionSemanticKey(action);
    const existing = grouped.get(key);
    if (existing) {
      existing.sourceIds = [...(existing.sourceIds ?? []), action.id];
      existing.sourceCount = existing.sourceIds.length;
      continue;
    }

    const passage = isPassageActionText(action.text);
    const chamber = chamberFromAction(action.text, action.chamber);
    const receipt = /received in (the )?(house|senate)/i.test(action.text);
    // Receipt/referral rows describe routing, not a vote outcome. Some official
    // copy recites that the originating chamber passed the bill; do not attach
    // that historical result to the receipt event itself.
    const outcome = receipt ? null : actionOutcome(action.text);
    const readableType = readableActionType(action.type, action.text);
    const label = passage
      ? `Passed${chamber ? ` ${chamber}` : ''}`
      : receipt
        ? `Received in${chamber ? ` ${chamber}` : ''}`
        : truncate(action.text, 90);
    const detail = passage
      ? passageDetail(action.text)
      : [chamber, readableType]
          .filter((part, index, all) => part && all.indexOf(part) === index)
          .join(' · ') || null;
    grouped.set(key, {
      date: toIso(action.date),
      label,
      detail,
      state: outcome?.sev === 'critical' ? 'failed' : 'done',
      sev: outcome?.sev,
      outcome: outcome?.label ?? null,
      outcomeSev: outcome?.sev ?? 'neutral',
      sourceIds: [action.id],
      sourceCount: 1,
    });
  }

  const result = [...grouped.values()].slice(0, limit);
  if (result[0]?.state === 'done') result[0].state = 'current';
  return result;
}
