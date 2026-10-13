import { type KeywordAst } from './legiwatch-query.js';
export declare const NEWS_QUERY_VERSION = "legiwatch-news-query-v1";
export declare const PHASE8_FEATURES: {
    readonly news: "legiwatch_news_v1";
    readonly budget: "legiwatch_florida_budget_v1";
    readonly editorial: "legiwatch_editorial_v1";
};
export type NewsFields = 'title' | 'title_summary' | 'available_text';
export declare function compileNewsQuery(raw: string): {
    adapterVersion: string;
    providerQuery: string | null;
    raw: string;
    parserVersion: string;
    status: "supported" | "unsupported" | "empty";
    ast: KeywordAst | null;
    reasons: string[];
    interpretation: string | null;
};
export declare function matchNews(raw: string, article: {
    title: string;
    summary?: string | null;
    body?: string | null;
    bodyComplete?: boolean;
}, fields?: NewsFields): {
    fields: NewsFields;
    parserVersion: string;
    outcome: "match" | "no_match" | "not_fully_evaluated";
    complete: boolean;
    evidence: import("./legiwatch-query.js").QueryEvidence[];
};
export declare function canonicalNewsUrl(raw: string): string;
export type EvidenceRef = {
    kind: 'news' | 'budget' | 'personnel' | 'research';
    id: string;
    revision: string;
    locator: string;
};
export type BudgetAmount = {
    id: string;
    projectId: string;
    fiscalYear: string;
    periodStart: string;
    periodEnd: string;
    currency: 'USD';
    fund: string;
    basis: 'recurring' | 'nonrecurring' | 'total';
    measure: 'money' | 'positions' | 'percentage';
    minorUnits: string | null;
    state: 'amount' | 'blank' | 'omitted' | 'embedded' | 'unpublished';
    stage: string;
    chamber: string;
    offer: string | null;
    sourceRevision: string;
    documentId: string;
    locator: string;
    unitMultiplier: string;
    allocationBasis: string;
    qualified: boolean;
    valueRole?: 'allocation_amount' | 'vetoed_amount';
};
export declare function dollarsToMinorUnits(raw: string, unitMultiplier?: string): string;
export declare function compareBudgetAmounts(left: BudgetAmount, right: BudgetAmount): {
    left: BudgetAmount;
    right: BudgetAmount;
    comparable: boolean;
    reasons: string[];
    deltaMinorUnits: null;
    percentage: null;
} | {
    left: BudgetAmount;
    right: BudgetAmount;
    comparable: boolean;
    reasons: string[];
    deltaMinorUnits: string;
    percentage: string | null;
};
export type BriefingTemplate = 'research_update' | 'daily_legislative_brief' | 'morning_news_brief';
export declare const BRIEFING_TEMPLATES: Record<BriefingTemplate, string>;
export type BriefingSchedule = {
    timezone: string;
    hour: number;
    minute: number;
    weekdays: number[];
    noChange: 'draft' | 'skip';
    sourceGap: 'hold' | 'draft';
    mode: 'prepare' | 'send';
};
export declare function validateBriefingSchedule(value: BriefingSchedule): BriefingSchedule;
/** One local-day identity: the repeated DST hour cannot create two editions;
 * a skipped hour catches up after the jump. Missed previous days stay missed. */
export declare function briefingOccurrence(now: Date, schedule: BriefingSchedule): string | null;
export declare const PHASE8_ALERT_FAMILIES: {
    readonly 'alert-01': {
        readonly family: "research_update";
        readonly displayName: "Research Desk";
        readonly categoryNamespace: "lobbytools-updates-alert";
        readonly categories: readonly ["1", "6", "4", "5", "10", "3", "11", "9"];
    };
    readonly 'alert-02': {
        readonly family: "budget";
        readonly displayName: "Budget Alert";
        readonly categoryNamespace: "lobbytools-budget-alert";
        readonly categories: readonly ["69", "61", "55", "49", "56"];
    };
    readonly 'alert-03': {
        readonly family: "daily_legislative_brief";
        readonly displayName: "Daily Briefing";
        readonly categoryNamespace: null;
        readonly categories: readonly [];
    };
    readonly 'alert-39': {
        readonly family: "morning_news_brief";
        readonly displayName: "Morning Edition";
        readonly categoryNamespace: null;
        readonly categories: readonly [];
    };
    readonly 'alert-40': {
        readonly family: "news_keyword";
        readonly displayName: "News Keyword";
        readonly categoryNamespace: null;
        readonly categories: readonly [];
    };
};
//# sourceMappingURL=legiwatch-phase8.d.ts.map