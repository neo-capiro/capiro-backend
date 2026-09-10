import { hydrateMeriStarterPrompt } from '@capiro/shared/meri-skills';
import { normalizeMeriQuickActionCatalog } from './VNextMeriContextRail.js';
import type { MeriIconName } from './meri-icons.js';
import type { MeriSavedPrompt } from './meri-vnext-api.js';

export type MeriStartWorkKind = 'skill' | 'prompt';

export interface MeriStartWorkCard {
  id: string;
  title: string;
  desc: string;
  tag: string;
  needsClient: boolean;
  fill: string;
  kind: MeriStartWorkKind;
  icon: MeriIconName;
}

const SKILL_ICONS: Record<string, MeriIconName> = {
  research_company: 'Building07',
  relationship_brief: 'Users02',
  client_changes: 'ClockFastForward',
  portfolio_changes: 'Grid01',
  portfolio_overlap: 'Dataflow03',
  // Quick Action skills wave 2 (PRs #1583–#1590). Unknown ids fall back to
  // 'Stars02' below, so a catalog entry never breaks the card grid.
  mail_history: 'Mail01',
  meeting_prep: 'CalendarCheck01',
  commitments_audit: 'ClipboardCheck',
  funding_opportunity_match: 'Coins01',
  pe_deep_dive: 'Target04',
  bill_watch: 'File04',
  hearing_watch: 'Calendar2',
  representation_lookup: 'MarkerPin01',
  regulatory_docket_brief: 'Scales01',
};

function skillDescription(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object') return fallback;
  const description = (value as { description?: unknown }).description;
  return typeof description === 'string' && description.trim() ? description.trim() : fallback;
}

function savedPrompts(value: unknown): MeriSavedPrompt[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row): MeriSavedPrompt[] => {
    if (!row || typeof row !== 'object') return [];
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.id !== 'string' || typeof candidate.title !== 'string') return [];
    const title = candidate.title.trim();
    const body = typeof candidate.body === 'string' ? candidate.body.trim() : '';
    if (!title || !body) return [];
    return [{
      id: candidate.id,
      title,
      body,
      createdAt: typeof candidate.createdAt === 'string' ? candidate.createdAt : '',
      updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    }];
  });
}

export function meriStartWorkCards(input: {
  skills?: unknown;
  prompts?: unknown;
  clientName?: string | null;
}): { skills: MeriStartWorkCard[]; prompts: MeriStartWorkCard[] } {
  const rawSkills =
    input.skills && typeof input.skills === 'object' && Array.isArray((input.skills as { skills?: unknown }).skills)
      ? ((input.skills as { skills: unknown[] }).skills)
      : [];
  const skills = normalizeMeriQuickActionCatalog(input.skills).map((action): MeriStartWorkCard => {
    const source = rawSkills.find((row) =>
      Boolean(row && typeof row === 'object' && (row as { id?: unknown }).id === action.id),
    );
    return {
      id: action.id,
      title: action.label,
      // Prefer the human description from the catalog — never show internal
      // recipe ids or raw starter-prompt placeholders as the card body.
      desc: skillDescription(source, action.description ?? 'Starts a guided Meri workflow.'),
      tag: action.requiresClient ? 'NEEDS A CLIENT' : 'READY TO USE',
      needsClient: action.requiresClient,
      fill: hydrateMeriStarterPrompt(action, { clientName: input.clientName }),
      kind: 'skill',
      icon: SKILL_ICONS[action.id] ?? 'Stars02',
    };
  });

  const prompts = savedPrompts(input.prompts).map((prompt): MeriStartWorkCard => ({
    id: prompt.id,
    title: prompt.title,
    // Keep the body as a short preview, not the whole monologue.
    desc: prompt.body.length > 140 ? `${prompt.body.slice(0, 137).trimEnd()}…` : prompt.body,
    tag: 'YOUR PROMPT',
    needsClient: false,
    fill: prompt.body,
    kind: 'prompt',
    icon: 'File05',
  }));

  return { skills, prompts };
}
