export declare const MERI_SKILL_SCOPES: readonly ["general", "client", "portfolio", "external_entity"];
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
export declare const MERI_SKILL_REGISTRY: readonly [{
    readonly id: "research_company";
    readonly label: "Research a Company";
    readonly description: "Federal market, Program Elements, contracts, grants, congressional opportunities, partners and capture strategy.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "research_federal_market_strategy";
    readonly permittedScopes: ["general", "client", "portfolio", "external_entity"];
    readonly starterPrompt: "Research [company name or domain] and build a comprehensive federal market strategy covering its capabilities, mission fit, Program Elements and procurement lines, contracts and OTAs, grants and innovation programs, partners, congressional opportunities, qualification gaps, capture strategy, a 90-day plan, and a long-range roadmap. Cite the supporting sources.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "public_web", "registries", "awards", "opportunities", "grants", "budget", "intelligence", "directory"];
    readonly readOnly: true;
}, {
    readonly id: "relationship_brief";
    readonly label: "Relationship Brief";
    readonly description: "Everything Capiro knows about a person or organization across authorized sources.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "transitional";
    readonly canonicalRecipe: "query_relationship_brief";
    readonly permittedScopes: ["general", "client", "external_entity"];
    readonly starterPrompt: "Tell me everything I should know about [person or organization]. Build a relationship brief across every authorized source that may contain relevant history, including email, meetings, contacts, notes, memory, documents, and commitments. Separate verified facts from inference and identify any incomplete source coverage.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "mail", "meetings", "contacts", "documents", "memory", "tasks"];
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "query_relationship";
}, {
    readonly id: "client_changes";
    readonly label: "Client Changes";
    readonly description: "What changed recently for the selected client.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "keep";
    readonly canonicalRecipe: "query_client_changes";
    readonly requiresClient: true;
    readonly permittedScopes: ["general", "client"];
    readonly starterPrompt: "What changed this week for this client? Check every required authorized source, distinguish new dated events from carryover, identify partial coverage, and do not claim that nothing happened unless the coverage manifest supports that conclusion.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["clients", "mail", "meetings", "tasks", "action_items", "outreach", "documents", "memory", "legislation", "intelligence"];
    readonly readOnly: true;
}, {
    readonly id: "portfolio_changes";
    readonly label: "Portfolio Changes";
    readonly description: "What changed across your active client portfolio.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "keep";
    readonly canonicalRecipe: "query_portfolio_changes";
    readonly permittedScopes: ["general", "portfolio"];
    readonly starterPrompt: "What changed across my active client portfolio this week? Enumerate the full authorized active-client roster, inspect every required source for each client, preserve per-client coverage, identify partial or unavailable sources, and separate dated events from carryover.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["clients", "mail", "meetings", "tasks", "action_items", "outreach", "documents", "memory", "legislation", "intelligence"];
    readonly readOnly: true;
}, {
    readonly id: "portfolio_overlap";
    readonly label: "Portfolio Overlap";
    readonly description: "Find strategic, capability and federal-market overlap between an external company and your clients.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "transitional";
    readonly canonicalRecipe: "query_portfolio_overlap";
    readonly permittedScopes: ["general", "portfolio", "external_entity"];
    readonly starterPrompt: "Search across my clients for overlap with [external company or domain]. Research the external company and return evidence-backed overlap in capabilities, agencies, military services, missions, Program Elements, NAICS, PSC, contracts, people, and strategic priorities. Do not imply an existing relationship unless the evidence proves one.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "clients", "budget", "awards", "registries", "directory", "intelligence", "public_web"];
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "portfolio graph retrieval";
}, {
    readonly id: "mail_history";
    readonly label: "Mail History";
    readonly description: "The correspondence timeline between us and a person or organization: key threads, commitments made, and open items, with message dates.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_relationship_brief";
    readonly permittedScopes: ["general", "client", "external_entity"];
    readonly starterPrompt: "Search my mailbox history with [person or organization] and produce a correspondence timeline. For each key thread: the subject, the dates, what was asked or promised, and any commitments or open items still outstanding. Cite message dates for every claim. Check every required authorized mail source before concluding; do not claim there is no correspondence unless the coverage manifest supports it.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["mail", "clients", "contacts", "documents", "tasks", "action_items"];
    readonly readOnly: true;
}, {
    readonly id: "meeting_prep";
    readonly label: "Meeting Prep Brief";
    readonly description: "Everything needed before a client, legislative or internal meeting: recent activity, key emails, prior conversations, decisions, open questions, deadlines and our commitments.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_relationship_brief";
    readonly permittedScopes: ["general", "client", "external_entity"];
    readonly starterPrompt: "Catch me up on [client, person, or issue] so I can prepare for my upcoming meeting. Cover: what has happened recently across every authorized source; the most important email exchanges; prior meetings and conversations; decisions already made; outstanding questions and unresolved issues; upcoming deadlines, meetings, and legislative developments; and everything we have committed to doing. Separate verified facts from inference, flag any incomplete source coverage, and end with a one-page pre-meeting checklist.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["clients", "mail", "meetings", "contacts", "documents", "memory", "tasks", "action_items", "outreach", "legislation"];
    readonly readOnly: true;
}, {
    readonly id: "commitments_audit";
    readonly label: "Commitments & Deliverables";
    readonly description: "What we promised a client, who owns each item, what is done, what needs follow-up, and commitments in emails or meetings never captured as tasks.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_client_changes";
    readonly requiresClient: true;
    readonly permittedScopes: ["general", "client"];
    readonly starterPrompt: "What has changed with the commitments and deliverables we owe this client? Audit every commitment we have made. List each commitment with: what was promised, when and where it was made, the internal owner, current status (completed, in progress, or no record of action), and what needs follow-up. Cross-check emails, meeting notes, debriefs, native tasks, action items, and monday.com work from boards explicitly mapped to this client or a board ID/link I supplied: explicitly flag any commitment found in an email or meeting summary that has no corresponding tracked task or action item. Do not treat unrelated personal monday.com work as this client’s commitment, do not mark anything complete without evidence, cite the underlying records, and say whether monday.com was checked, disconnected, unavailable, or not mapped.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["clients", "mail", "meetings", "tasks", "monday", "action_items", "documents", "memory"];
    readonly readOnly: true;
}, {
    readonly id: "funding_opportunity_match";
    readonly label: "Funding Opportunity Match";
    readonly description: "Find active SAM.gov / Grants.gov funding opportunities and score their fit against one client: capabilities, past awards, agency landscape, and a cited verdict.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_funding_opportunity_match";
    readonly requiresClient: true;
    readonly permittedScopes: ["general", "client"];
    readonly starterPrompt: "Find active funding opportunities for {{clientName}} and score how well each fits us. For each candidate: what it funds, how it aligns with our capabilities and past awards, the agency and program landscape, and a fit verdict with citations. Note any source you could not check — the match evidence is top-k, not exhaustive.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["opportunities", "clients", "identity", "grants", "budget"];
    readonly readOnly: true;
}, {
    readonly id: "pe_deep_dive";
    readonly label: "PE Deep Dive";
    readonly description: "Complete brief on one DoD Program Element: definition, budget timeline, Congressional report language, contractors, and related bills.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_pe_deep_dive";
    readonly requiresClient: false;
    readonly permittedScopes: ["general", "external_entity"];
    readonly starterPrompt: "Give me a complete brief on Program Element [PE number or name]: what it funds, the budget line over the FYDP, the report language Congress attached, who the contractors are, and any authorizing or appropriating bills touching it. If I did not give a PE number, resolve it first and confirm the match. Name any source you could not check.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["budget", "awards", "legislation"];
    readonly readOnly: true;
}, {
    readonly id: "bill_watch";
    readonly label: "Bill Watch";
    readonly description: "Track the status of federal and state bills affecting a client: what we watch, what Congress is doing, and state legislation where the client has a footprint.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_bill_watch";
    readonly permittedScopes: ["client", "general"];
    readonly starterPrompt: "What is the status of bills affecting [client name]? Include federal bills and any state legislation where we have a footprint.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "legislation"];
    readonly requiresClient: true;
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "legislation graph retrieval";
}, {
    readonly id: "hearing_watch";
    readonly label: "Hearing Watch";
    readonly description: "Committee hearings on the calendar that matter to a client, with any LegiWatch hearing handoff surfaced so the answer cites the hearing you were viewing.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_hearing_watch";
    readonly permittedScopes: ["client", "general"];
    readonly starterPrompt: "What committee hearings are coming up that [client name] should care about?";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "hearings"];
    readonly requiresClient: true;
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "legislation graph retrieval";
}, {
    readonly id: "representation_lookup";
    readonly label: "Representation Lookup";
    readonly description: "Who represents a district or state: the member roster plus the client-scoped mapping of which members touch our facilities and footprint.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_representation_lookup";
    readonly permittedScopes: ["client", "general"];
    readonly starterPrompt: "Who represents [state or district], and which of them touch [client name]?";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["identity", "directory"];
    readonly requiresClient: false;
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "directory graph retrieval";
}, {
    readonly id: "regulatory_docket_brief";
    readonly label: "Regulatory Docket Brief";
    readonly description: "Where a rulemaking stands: federal docket activity plus state register implementation status, with both lanes checked and named in the coverage manifest.";
    readonly userVisible: true;
    readonly quickAction: true;
    readonly lifecycle: "permanent";
    readonly canonicalRecipe: "query_regulatory_docket_brief";
    readonly permittedScopes: ["general"];
    readonly starterPrompt: "Where does the rulemaking on [rule or docket keyword] stand? Cover the federal docket and any state register activity.";
    readonly requiredEntitlements: [];
    readonly semanticDomains: ["regulatory"];
    readonly requiresClient: false;
    readonly readOnly: true;
    readonly knowledgePlaneReplacement: "regulatory graph retrieval";
}];
export interface ListMeriSkillsOptions {
    entitlements?: Iterable<string>;
    scope?: MeriSkillScope;
    quickActionsOnly?: boolean;
}
export declare function listMeriSkills(options?: ListMeriSkillsOptions): MeriSkillDefinition[];
export declare function listMeriQuickActions(options?: Omit<ListMeriSkillsOptions, 'quickActionsOnly'>): MeriSkillDefinition[];
export declare function hydrateMeriStarterPrompt(skill: Pick<MeriSkillDefinition, 'starterPrompt'>, context?: {
    clientName?: string | null;
}): string;
//# sourceMappingURL=meri-skills.d.ts.map