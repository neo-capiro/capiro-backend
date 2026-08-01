// Single source of truth for the core memory-file section catalog.
//
// Each memory type (firm-soul, client-soul, etc.) is composed of human-authored
// sections. Every section carries:
//   - heading: shown in the editor and rendered markdown
//   - prompt:  the "what to write here" guidance (greyed help) AND the question
//              the Meri interview asks for this section
//   - example: a short, demo-defensible sample line (greyed italic in the UI)
//
// This catalog is consumed by: the seed (skeleton creation), the Settings
// Memory tab (help text + section list), and the interview (questions). Keeping
// it here means help, questions, and skeletons never drift apart.

export interface SectionDef {
  key: string;
  heading: string;
  prompt: string;
  example: string;
}

export interface MemoryFileDef {
  /** MemoryItemType this file maps to. */
  type: string;
  /** 'firm' = tenant-wide; 'client' = per-client; 'user' = personal profile. */
  scope: 'firm' | 'client' | 'user';
  label: string;
  blurb: string;
  sections: SectionDef[];
}

export const MEMORY_CATALOG: MemoryFileDef[] = [
  {
    type: 'firm-soul',
    scope: 'firm',
    label: 'Firm Soul',
    blurb: 'Who the firm is and how it operates — the identity every engagement inherits.',
    sections: [
      {
        key: 'mission',
        heading: 'Mission & mandate',
        prompt: 'Why the firm exists.',
        example:
          'We help maritime and defense clients turn federal policy shifts into protected funding and favorable language.',
      },
      {
        key: 'philosophy',
        heading: 'Advocacy philosophy',
        prompt: 'How we win.',
        example:
          'Relationship-first, bipartisan, always bringing members a credible local-jobs story.',
      },
      {
        key: 'values',
        heading: 'Core values',
        prompt: 'Non-negotiable principles.',
        example: 'Candor with clients, discretion on the Hill, never overpromise access.',
      },
      {
        key: 'compliance',
        heading: 'Ethics & compliance posture',
        prompt: 'LDA discipline, gift rules, conflicts.',
        example:
          'Strict LDA quarterly filing; no gifts beyond de minimis; conflicts cleared before engagement.',
      },
      {
        key: 'positioning',
        heading: 'Bipartisan positioning & no-go list',
        prompt: 'Where we will and will not play.',
        example:
          'We work both caucuses on appropriations; we decline tobacco and foreign-state principals.',
      },
    ],
  },
  {
    type: 'firm-compass',
    scope: 'firm',
    label: 'Firm Compass',
    blurb: 'Where the practice is headed.',
    sections: [
      {
        key: 'vision',
        heading: '3–5 year vision',
        prompt: 'Where the practice is going.',
        example:
          'Become the go-to shop for shipyard and port-infrastructure appropriations by 2028.',
      },
      {
        key: 'book',
        heading: 'Book-of-business goals',
        prompt: 'Target client/sector mix.',
        example: 'Grow defense-industrial from 3 to 6 retainers; add two port authorities.',
      },
      {
        key: 'themes',
        heading: 'Yearly themes',
        prompt: 'The throughline this year.',
        example:
          'This year: ride the shipbuilding-supplemental cycle and deepen Senate Approps ties.',
      },
    ],
  },
  {
    type: 'playbook',
    scope: 'firm',
    label: 'Playbook',
    blurb: 'How the firm runs the work — repeatable standards.',
    sections: [
      {
        key: 'engagement',
        heading: 'How we run an engagement',
        prompt: 'Standard cadence and milestones.',
        example:
          'Kickoff strategy memo in week 1; biweekly client calls; quarterly Hill-action review.',
      },
      {
        key: 'escalation',
        heading: 'Escalation paths',
        prompt: 'Who gets pulled in, when.',
        example:
          'Partner joins any meeting with a full committee chair or when a client redline is at risk.',
      },
      {
        key: 'debrief',
        heading: 'What a good debrief looks like',
        prompt: 'The bar for a useful debrief.',
        example:
          'Who was in the room, what they committed to, the ask we left, and the next touch date.',
      },
    ],
  },
  {
    type: 'client-soul',
    scope: 'client',
    label: 'Client Soul',
    blurb: "A client's identity and our honest strategic read — the most valuable judgment file.",
    sections: [
      {
        key: 'who-they-are',
        heading: 'Who they are & what they do',
        prompt: 'One-paragraph orientation.',
        example:
          'Mid-size shipbuilder, 2,400 jobs across two coastal districts, prime subcontractor on Navy hulls.',
      },
      {
        key: 'priorities',
        heading: 'Stated vs. real priorities',
        prompt: 'What they say they want vs. what actually moves them.',
        example:
          'Say: "support shipbuilding." Real: protect the FY supplemental line that funds their yard.',
      },
      {
        key: 'decision-makers',
        heading: 'Decision-makers & how they decide',
        prompt: 'Who signs off; what wins internal buy-in.',
        example: 'CEO decides; GC must bless anything public; board wants quarterly proof of ROI.',
      },
      {
        key: 'risk-posture',
        heading: 'Risk tolerance & political posture',
        prompt: 'Aggressive/cautious; partisan constraints.',
        example:
          'Cautious publicly; avoids partisan framing; will not testify but will host site visits.',
      },
      {
        key: 'red-lines',
        heading: 'Red lines / never-do',
        prompt: 'Hard constraints we must not cross.',
        example: 'Never lobby against a home-state member; no press without GC sign-off.',
      },
      {
        key: 'relationship',
        heading: 'Relationship temperature & trust history',
        prompt: 'How the relationship has trended; past friction.',
        example:
          'Strong since 2024; one friction point over a missed markup heads-up, since repaired.',
      },
      {
        key: 'strategic-read',
        heading: 'Our strategic read',
        prompt: "The lobbyist's honest assessment.",
        example:
          'Renewal hinges on landing the supplemental; widen beyond one champion to de-risk.',
      },
    ],
  },
  {
    type: 'client-compass',
    scope: 'client',
    label: 'Client Compass',
    blurb: 'Direction and the active campaign for this client.',
    sections: [
      {
        key: 'north-star',
        heading: 'North Star outcomes',
        prompt: 'What winning looks like over the horizon.',
        example: 'A recurring shipbuilding line item that survives across appropriations cycles.',
      },
      {
        key: 'objectives',
        heading: 'Active objectives',
        prompt: 'Link [[bill:...]] / [[issue:...]] targets.',
        example:
          'Secure report language in [[bill:119-hr-1234]]; defend funding under [[issue:SHIP]].',
      },
      {
        key: 'timeline',
        heading: 'Campaign timeline & key dates',
        prompt: 'Markups, deadlines, recess windows.',
        example: 'Subcommittee markup ~June; aim for asks landed before the July recess.',
      },
      {
        key: 'metrics',
        heading: 'Success metrics',
        prompt: 'Demo-defensible only — no invented stats.',
        example:
          'Meetings secured with target offices; language adopted; funding retained vs. prior year.',
      },
      {
        key: 'themes',
        heading: 'Yearly account themes',
        prompt: 'The throughline for this account this year.',
        example: 'Frame every ask around local jobs and supply-chain resilience.',
      },
    ],
  },
  {
    type: 'client-people',
    scope: 'client',
    label: 'Client People',
    blurb: 'The relationship directory for this client.',
    sections: [
      {
        key: 'their-team',
        heading: 'Their team',
        prompt: 'Internal contacts; link [[person:...]].',
        example: 'CEO [[person:jane-doe]] (decides), GC [[person:sam-lee]] (gatekeeper).',
      },
      {
        key: 'offices',
        heading: 'Relevant offices & members',
        prompt: 'Hill offices/staffers; link [[person:...]].',
        example: 'Sen. Approps Defense subcmte; LA [[person:alex-kim]] is our day-to-day.',
      },
      {
        key: 'commitments',
        heading: 'Commitments made',
        prompt: 'What we promised whom, and when.',
        example: 'Promised the LA a one-pager on yard jobs by Friday (made 6/20).',
      },
      {
        key: 'key-conversations',
        heading: 'Key conversations',
        prompt: 'Dated notes on pivotal exchanges.',
        example: '6/18: chief signaled openness to report language if paired with a jobs number.',
      },
    ],
  },
  {
    type: 'user-profile',
    scope: 'user',
    label: 'My Profile',
    blurb: 'Who you are at the firm — your role, focus, and working context. Private to you.',
    sections: [
      {
        key: 'role',
        heading: 'Role & responsibilities',
        prompt: 'Your title and what you own day-to-day.',
        example:
          'Senior associate; run defense-industrial accounts and Senate Approps relationships.',
      },
      {
        key: 'focus',
        heading: 'Accounts & focus areas',
        prompt: 'Clients, issues, and committees you cover.',
        example: 'Lead on two shipbuilders; cover SASC, SAC-D, and the shipbuilding supplemental.',
      },
      {
        key: 'working-style',
        heading: 'How I work',
        prompt: 'Cadence, strengths, what to hand you vs. not.',
        example: 'Strong on member meetings and strategy memos; prefer to draft asks myself.',
      },
    ],
  },
  {
    type: 'user-voice',
    scope: 'user',
    label: 'My Writing Style',
    blurb:
      'How you write, so Meri can draft in your voice. Paste real samples below for few-shot grounding. Private to you.',
    sections: [
      {
        key: 'preferences',
        heading: 'Communication preferences',
        prompt: "Tone, length, formality, do/don't for your writing.",
        example:
          'Direct and concise; no hedging or filler; active voice; lead with the ask; avoid exclamation points.',
      },
      {
        key: 'audiences',
        heading: 'Audience adjustments',
        prompt: 'How your voice shifts by audience (member office vs. client vs. internal).',
        example:
          'To Hill staff: crisp, deferential, jobs-framed. To clients: plain-English, decision-oriented.',
      },
      {
        key: 'samples',
        heading: 'Sample writings (few-shot)',
        prompt:
          'Paste 2–4 real things you wrote (emails, memos, asks). Meri mimics this voice — do not invent.',
        example:
          'Paste a real email and a memo paragraph here; the more representative, the better Meri matches you.',
      },
    ],
  },
];

/** Look up a file definition by memory type. */
export function fileDefForType(type: string): MemoryFileDef | undefined {
  return MEMORY_CATALOG.find((f) => f.type === type);
}

/** The set of human-editable section keys for a type (write-guard allowlist). */
export function editableSectionKeys(type: string): Set<string> {
  return new Set(fileDefForType(type)?.sections.map((s) => s.key) ?? []);
}

/** Build an empty section skeleton (all human-owned, blank bodies) for a file type. */
export function skeletonSections(
  type: string,
): Array<{ key: string; heading: string; owner: 'human'; body: string }> {
  return (fileDefForType(type)?.sections ?? []).map((s) => ({
    key: s.key,
    heading: s.heading,
    owner: 'human' as const,
    body: '',
  }));
}

/** A stored/merged memory section. (Mirrors MemorySection in memory.types.) */
export interface CatalogMergeSection {
  key: string;
  heading: string;
  owner: 'engine' | 'human';
  body: string;
}

/**
 * Merge user edits into a file's sections, canonically.
 *
 * Walks the CATALOG skeleton (not just the stored sections) so that EVERY
 * human-editable section is always present and saveable — fixing the bug where
 * edits to a catalog section missing from a stale/partially-created stored row
 * were silently dropped ("some files don't save"). Existing bodies + owners are
 * preserved; edits apply only to human-owned, allowed keys; engine-owned
 * sections (and any stored sections the catalog no longer lists) are carried
 * through untouched. Pure → unit-tested in memory-catalog.spec.ts.
 */
export function mergeEditedSections(
  type: string,
  existingSections: CatalogMergeSection[] | null,
  edits: Array<{ key: string; body: string }>,
  allowedKeys: Set<string>,
): CatalogMergeSection[] {
  const editByKey = new Map(
    edits.filter((e) => allowedKeys.has(e.key)).map((e) => [e.key, e.body]),
  );
  const existingByKey = new Map((existingSections ?? []).map((s) => [s.key, s]));
  const seen = new Set<string>();
  const merged: CatalogMergeSection[] = [];
  for (const skel of skeletonSections(type)) {
    seen.add(skel.key);
    const base: CatalogMergeSection = existingByKey.get(skel.key) ?? {
      key: skel.key,
      heading: skel.heading,
      owner: 'human',
      body: '',
    };
    if (base.owner === 'human' && allowedKeys.has(skel.key) && editByKey.has(skel.key)) {
      merged.push({ ...base, body: editByKey.get(skel.key) ?? base.body });
    } else {
      merged.push(base);
    }
  }
  // Preserve stored sections the catalog no longer lists (e.g. ingestion-derived).
  for (const s of existingSections ?? []) {
    if (!seen.has(s.key)) merged.push(s);
  }
  return merged;
}
