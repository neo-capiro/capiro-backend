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
      desc: skillDescription(source, action.starterPrompt),
      tag: action.requiresClient ? 'ONE CLIENT' : 'SKILL',
      needsClient: action.requiresClient,
      fill: hydrateMeriStarterPrompt(action, { clientName: input.clientName }),
      kind: 'skill',
      icon: SKILL_ICONS[action.id] ?? 'Stars02',
    };
  });

  const prompts = savedPrompts(input.prompts).map((prompt): MeriStartWorkCard => ({
    id: prompt.id,
    title: prompt.title,
    desc: prompt.body,
    tag: 'SAVED PROMPT',
    needsClient: false,
    fill: prompt.body,
    kind: 'prompt',
    icon: 'File05',
  }));

  return { skills, prompts };
}
