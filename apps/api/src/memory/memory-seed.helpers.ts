// Institutional Memory — identity-file skeleton seeding (plan §1.5).
//
// Pure factory functions that build the human-owned identity MemoryItems for a
// client (hub, soul, compass, people) and the firm (soul, compass, playbook).
// All are provenance='human': the engine CREATES the skeleton once, then never
// regenerates the prose (criterion #8). Section bodies are gov-affairs best-
// practice prompts the analyst fills in.

import type { MemoryItem, MemorySection } from './memory.types.js';
import { MEMORY_SCHEMA_VERSION, defaultMemoryGovernanceFields } from './memory.types.js';

function nowIso(): string {
  return new Date().toISOString();
}

function humanSection(key: string, heading: string, prompt: string): MemorySection {
  return { key, heading, owner: 'human', body: `_${prompt}_` };
}

interface SeedCtx {
  tenantId: string;
  clientId: string;
  clientSlug: string;
  clientName: string;
  /** authoritative client entity id (Postgres Client.id) */
  entityId: string;
}

/** client hub (index.md) — map-of-content; links the rest of the pack. */
export function seedClientHub(ctx: SeedCtx): MemoryItem {
  const ts = nowIso();
  return {
    id: '', // assigned by the store on insert
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    ownerUserId: null,
    type: 'client-hub',
    visibility: 'tenant',
    entityId: ctx.entityId,
    slug: ctx.clientSlug,
    title: `${ctx.clientName} — Hub`,
    aliases: [],
    tags: ['client', 'hub'],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [
      {
        key: 'links',
        heading: 'Map of content',
        owner: 'engine',
        body: [
          `- [[client-soul:${ctx.clientSlug}]] — who they are & our strategic read`,
          `- [[client-compass:${ctx.clientSlug}]] — direction & campaign`,
          `- [[client-people:${ctx.clientSlug}]] — relationship directory`,
          `- [[client-profile:${ctx.clientSlug}]] — generated facts`,
        ].join('\n'),
      },
    ],
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

/** client soul.md — identity & our strategic read (most valuable judgment file). */
export function seedClientSoul(ctx: SeedCtx): MemoryItem {
  const ts = nowIso();
  return {
    id: '',
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    ownerUserId: null,
    type: 'client-soul',
    visibility: 'tenant',
    entityId: ctx.entityId,
    slug: ctx.clientSlug,
    title: `${ctx.clientName} — Identity & Strategic Read`,
    aliases: [],
    tags: ['client', 'soul'],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [
      humanSection('who-they-are', 'Who they are & what they do', 'One-paragraph orientation.'),
      humanSection('priorities', 'Stated vs. real priorities', 'What they say they want vs. what actually moves them.'),
      humanSection('decision-makers', 'Decision-makers & how they decide', 'Who signs off; what wins internal buy-in.'),
      humanSection('risk-posture', 'Risk tolerance & political posture', 'Aggressive/cautious; partisan constraints.'),
      humanSection('red-lines', 'Red lines / never-do', 'Hard constraints we must not cross.'),
      humanSection('relationship', 'Relationship temperature & trust history', 'How the relationship has trended; past friction.'),
      humanSection('strategic-read', 'Our strategic read', "The lobbyist's honest assessment."),
    ],
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

/** client compass.md — direction & our campaign. */
export function seedClientCompass(ctx: SeedCtx): MemoryItem {
  const ts = nowIso();
  return {
    id: '',
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    ownerUserId: null,
    type: 'client-compass',
    visibility: 'tenant',
    entityId: ctx.entityId,
    slug: ctx.clientSlug,
    title: `${ctx.clientName} — Direction & Campaign`,
    aliases: [],
    tags: ['client', 'compass'],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [
      humanSection('north-star', 'North Star outcomes', 'What winning looks like over the horizon.'),
      humanSection('objectives', 'Active objectives', 'Link [[bill:...]] / [[issue:...]] targets.'),
      humanSection('timeline', 'Campaign timeline & key dates', 'Markups, deadlines, recess windows.'),
      humanSection('metrics', 'Success metrics', 'Demo-defensible only — no invented stats.'),
      humanSection('themes', 'Yearly account themes', 'The throughline for this account this year.'),
    ],
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

/** client people.md — relationship directory. */
export function seedClientPeople(ctx: SeedCtx): MemoryItem {
  const ts = nowIso();
  return {
    id: '',
    tenantId: ctx.tenantId,
    clientId: ctx.clientId,
    ownerUserId: null,
    type: 'client-people',
    visibility: 'tenant',
    entityId: ctx.entityId,
    slug: ctx.clientSlug,
    title: `${ctx.clientName} — Relationship Directory`,
    aliases: [],
    tags: ['client', 'people'],
    source: 'manual',
    sourceRef: null,
    provenance: 'human',
    sections: [
      humanSection('their-team', 'Their team', 'Internal contacts; link [[person:...]].'),
      humanSection('offices', 'Relevant offices & members', 'Hill offices/staffers; link [[person:...]].'),
      humanSection('commitments', 'Commitments made', 'What we promised whom, and when.'),
      humanSection('key-conversations', 'Key conversations', 'Dated notes on pivotal exchanges.'),
    ],
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
}

/** All four client identity skeletons. Criterion #8: a complete hub. */
export function seedClientPack(ctx: SeedCtx): MemoryItem[] {
  return [
    seedClientHub(ctx),
    seedClientSoul(ctx),
    seedClientCompass(ctx),
    seedClientPeople(ctx),
  ];
}

/** Firm-level identity skeletons (soul, compass, playbook). */
export function seedFirmPack(tenantId: string, firmName: string): MemoryItem[] {
  const ts = nowIso();
  const base = {
    tenantId,
    clientId: null,
    ownerUserId: null,
    visibility: 'tenant' as const,
    entityId: null,
    aliases: [] as string[],
    source: 'manual' as const,
    sourceRef: null,
    provenance: 'human' as const,
    createdAt: ts,
    updatedAt: ts,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    ...defaultMemoryGovernanceFields(),
  };
  return [
    {
      ...base,
      id: '',
      type: 'firm-soul',
      slug: 'firm',
      title: `${firmName} — Firm Identity`,
      tags: ['firm', 'soul'],
      sections: [
        humanSection('mission', 'Mission & mandate', 'Why the firm exists.'),
        humanSection('philosophy', 'Advocacy philosophy', 'How we win.'),
        humanSection('values', 'Core values', 'Non-negotiable principles.'),
        humanSection('compliance', 'Ethics & compliance posture', 'LDA discipline, gift rules, conflicts.'),
        humanSection('positioning', 'Bipartisan positioning & no-go list', 'Where we will and will not play.'),
      ],
    },
    {
      ...base,
      id: '',
      type: 'firm-compass',
      slug: 'firm',
      title: `${firmName} — Firm Direction`,
      tags: ['firm', 'compass'],
      sections: [
        humanSection('vision', '3–5 year vision', 'Where the practice is going.'),
        humanSection('book', 'Book-of-business goals', 'Target client/sector mix.'),
        humanSection('themes', 'Yearly themes', 'The throughline this year.'),
      ],
    },
    {
      ...base,
      id: '',
      type: 'playbook',
      slug: 'firm',
      title: `${firmName} — Firm Playbook`,
      tags: ['firm', 'playbook'],
      sections: [
        humanSection('engagement', 'How we run an engagement', 'Standard cadence and milestones.'),
        humanSection('escalation', 'Escalation paths', 'Who gets pulled in, when.'),
        humanSection('debrief', 'What a good debrief looks like', 'The bar for a useful debrief.'),
      ],
    },
  ];
}
