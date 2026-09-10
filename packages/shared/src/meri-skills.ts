export const MERI_SKILL_SCOPES = [
  'general',
  'client',
  'portfolio',
  'external_entity',
] as const;

export type MeriSkillScope = (typeof MERI_SKILL_SCOPES)[number];

export type MeriSkillLifecycle = 'permanent' | 'keep' | 'transitional';

/**
 * Canonical product definition for one Meri skill.
 *
 * This registry is intentionally about user-facing intentions and canonical
 * backend recipes. It is not a second tool catalog and must never duplicate
 * Knowledge Plane dictionaries, entity definitions, or raw API schemas.
 */
export interface MeriSkillDefinition {
  id: string;
  label: string;
  description: string;
  userVisible: boolean;
  quickAction: boolean;
  lifecycle: MeriSkillLifecycle;
  canonicalRecipe?: string;
  requiresClient?: boolean;
  permittedScopes: MeriSkillScope[];
  starterPrompt: string;
  requiredEntitlements?: string[];
  semanticDomains: string[];
  readOnly: boolean;
  deprecated?: boolean;
  knowledgePlaneReplacement?: string;
}

export const MERI_SKILL_REGISTRY = [
  {
    id: 'research_company',
    label: 'Research a Company',
    description:
      'Federal market, Program Elements, contracts, grants, congressional opportunities, partners and capture strategy.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'permanent',
    canonicalRecipe: 'research_federal_market_strategy',
    permittedScopes: ['general', 'client', 'portfolio', 'external_entity'],
    starterPrompt:
      'Research [company name or domain] and build a comprehensive federal market strategy covering its capabilities, mission fit, Program Elements and procurement lines, contracts and OTAs, grants and innovation programs, partners, congressional opportunities, qualification gaps, capture strategy, a 90-day plan, and a long-range roadmap. Cite the supporting sources.',
    requiredEntitlements: [],
    semanticDomains: [
      'identity',
      'public_web',
      'registries',
      'awards',
      'opportunities',
      'grants',
      'budget',
      'intelligence',
      'directory',
    ],
    readOnly: true,
  },
  {
    id: 'relationship_brief',
    label: 'Relationship Brief',
    description:
      'Everything Capiro knows about a person or organization across authorized sources.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'transitional',
    canonicalRecipe: 'query_relationship_brief',
    permittedScopes: ['general', 'client', 'external_entity'],
    starterPrompt:
      'Tell me everything I should know about [person or organization]. Build a relationship brief across every authorized source that may contain relevant history, including email, meetings, contacts, notes, memory, documents, and commitments. Separate verified facts from inference and identify any incomplete source coverage.',
    requiredEntitlements: [],
    semanticDomains: [
      'identity',
      'mail',
      'meetings',
      'contacts',
      'documents',
      'memory',
      'tasks',
    ],
    readOnly: true,
    knowledgePlaneReplacement: 'query_relationship',
  },
  {
    id: 'client_changes',
    label: 'Client Changes',
    description: 'What changed recently for the selected client.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'keep',
    canonicalRecipe: 'query_client_changes',
    requiresClient: true,
    permittedScopes: ['general', 'client'],
    starterPrompt:
      'What changed this week for this client? Check every required authorized source, distinguish new dated events from carryover, identify partial coverage, and do not claim that nothing happened unless the coverage manifest supports that conclusion.',
    requiredEntitlements: [],
    semanticDomains: [
      'clients',
      'mail',
      'meetings',
      'tasks',
      'action_items',
      'outreach',
      'documents',
      'memory',
      'legislation',
      'intelligence',
    ],
    readOnly: true,
  },
  {
    id: 'portfolio_changes',
    label: 'Portfolio Changes',
    description: 'What changed across your active client portfolio.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'keep',
    canonicalRecipe: 'query_portfolio_changes',
    permittedScopes: ['general', 'portfolio'],
    starterPrompt:
      'What changed across my active client portfolio this week? Enumerate the full authorized active-client roster, inspect every required source for each client, preserve per-client coverage, identify partial or unavailable sources, and separate dated events from carryover.',
    requiredEntitlements: [],
    semanticDomains: [
      'clients',
      'mail',
      'meetings',
      'tasks',
      'action_items',
      'outreach',
      'documents',
      'memory',
      'legislation',
      'intelligence',
    ],
    readOnly: true,
  },
  {
    id: 'portfolio_overlap',
    label: 'Portfolio Overlap',
    description:
      'Find strategic, capability and federal-market overlap between an external company and your clients.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'transitional',
    canonicalRecipe: 'query_portfolio_overlap',
    permittedScopes: ['general', 'portfolio', 'external_entity'],
    starterPrompt:
      'Search across my clients for overlap with [external company or domain]. Research the external company and return evidence-backed overlap in capabilities, agencies, military services, missions, Program Elements, NAICS, PSC, contracts, people, and strategic priorities. Do not imply an existing relationship unless the evidence proves one.',
    requiredEntitlements: [],
    semanticDomains: [
      'identity',
      'clients',
      'budget',
      'awards',
      'registries',
      'directory',
      'intelligence',
      'public_web',
    ],
    readOnly: true,
    knowledgePlaneReplacement: 'portfolio graph retrieval',
  },
  {
    id: 'mail_history',
    label: 'Mail History',
    description:
      'The correspondence timeline between us and a person or organization: key threads, commitments made, and open items, with message dates.',
    userVisible: true,
    quickAction: true,
    lifecycle: 'permanent',
    canonicalRecipe: 'query_relationship_brief',
    permittedScopes: ['general', 'client', 'external_entity'],
    starterPrompt:
      'Search my mailbox history with [person or organization] and produce a correspondence timeline. For each key thread: the subject, the dates, what was asked or promised, and any commitments or open items still outstanding. Cite message dates for every claim. Check every required authorized mail source before concluding; do not claim there is no correspondence unless the coverage manifest supports it.',
    requiredEntitlements: [],
    semanticDomains: ['mail', 'clients', 'contacts', 'documents', 'tasks', 'action_items'],
    readOnly: true,
  },
] as const satisfies readonly MeriSkillDefinition[];

export interface ListMeriSkillsOptions {
  entitlements?: Iterable<string>;
  scope?: MeriSkillScope;
  quickActionsOnly?: boolean;
}

export function listMeriSkills(options: ListMeriSkillsOptions = {}): MeriSkillDefinition[] {
  const entitlements = new Set(options.entitlements ?? []);
  const registry: readonly MeriSkillDefinition[] = MERI_SKILL_REGISTRY;
  return registry
    .filter((skill) => {
      if (!skill.userVisible || skill.deprecated) return false;
      if (options.quickActionsOnly && !skill.quickAction) return false;
      if (options.scope && !skill.permittedScopes.includes(options.scope)) return false;
      return (skill.requiredEntitlements ?? []).every((item) => entitlements.has(item));
    })
    .map((skill) => ({
      ...skill,
      permittedScopes: [...skill.permittedScopes],
      requiredEntitlements: [...(skill.requiredEntitlements ?? [])],
      semanticDomains: [...skill.semanticDomains],
    }));
}

export function listMeriQuickActions(options: Omit<ListMeriSkillsOptions, 'quickActionsOnly'> = {}) {
  return listMeriSkills({ ...options, quickActionsOnly: true });
}

export function hydrateMeriStarterPrompt(
  skill: Pick<MeriSkillDefinition, 'starterPrompt'>,
  context: { clientName?: string | null } = {},
): string {
  const clientName = context.clientName?.trim() || 'the client selected in SCOPE';
  return skill.starterPrompt.replaceAll('{{clientName}}', clientName);
}
