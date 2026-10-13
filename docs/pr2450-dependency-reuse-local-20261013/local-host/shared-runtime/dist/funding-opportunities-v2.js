"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_OPPORTUNITY_KEYWORD_TERMS = exports.OPPORTUNITY_QUERY_MATCHES_V2 = exports.OPPORTUNITY_SORTS_V2 = exports.OPPORTUNITY_TYPES_V2 = exports.OPPORTUNITY_LIFECYCLES_V2 = exports.OPPORTUNITY_SOURCES_V2 = exports.OPPORTUNITY_SEARCH_MODES = void 0;
exports.normalizeOpportunitySearchCriteria = normalizeOpportunitySearchCriteria;
exports.OPPORTUNITY_SEARCH_MODES = ['matched', 'all'];
exports.OPPORTUNITY_SOURCES_V2 = [
    'grants_gov',
    'sam_gov',
    'agency_forecast',
    'dibbs',
    'sbir_sttr',
    'ca_portal',
];
exports.OPPORTUNITY_LIFECYCLES_V2 = ['active', 'forecast', 'closed', 'post_award'];
exports.OPPORTUNITY_TYPES_V2 = [
    'grant',
    'cooperative_agreement',
    'loan_assistance',
    'contract',
    'solicitation',
    'task_order_vehicle',
    'presolicitation',
    'sources_sought',
    'forecast',
    'award',
    'other',
];
exports.OPPORTUNITY_SORTS_V2 = [
    'deadline',
    'relevance',
    'title',
    'posted',
    'value',
    'agency',
    'updated',
];
exports.OPPORTUNITY_QUERY_MATCHES_V2 = ['keywords', 'phrase'];
exports.MAX_OPPORTUNITY_KEYWORD_TERMS = 100;
const DEFAULT_CRITERIA = {
    schemaVersion: 2,
    mode: 'all',
    clientId: null,
    query: '',
    sources: [],
    types: [],
    lifecycle: ['active'],
    agencies: [],
    sectors: [],
    naicsCodes: [],
    pscCodes: [],
    setAsideCodes: [],
    eligibility: [],
    posted: [],
    geography: [],
    applicantTypes: [],
    funding: [],
    costShare: [],
    methods: [],
    disbursement: [],
    grantPrerequisites: [],
    codes: [],
    deadlineWindow: 'any',
    deadlineFrom: null,
    deadlineTo: null,
    sort: 'deadline',
    direction: 'asc',
    page: 1,
    pageSize: 20,
};
const SUPPORTED_KEYS = new Set([
    'schemaVersion',
    'mode',
    'clientId',
    'query',
    'queryMatch',
    'keywordTerms',
    'sources',
    'types',
    'lifecycle',
    'agencies',
    'sectors',
    'naicsCodes',
    'pscCodes',
    'setAsideCodes',
    'eligibility',
    'posted',
    'geography',
    'applicantTypes',
    'funding',
    'costShare',
    'methods',
    'disbursement',
    'grantPrerequisites',
    'codes',
    'deadlineFrom',
    'deadlineWindow',
    'deadlineTo',
    'sort',
    'direction',
    'page',
    'pageSize',
]);
function text(value) {
    return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}
function list(value) {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    return [...new Set(values.map(text).filter(Boolean))];
}
function enumList(value, allowed) {
    const allowedSet = new Set(allowed);
    return list(value).filter((item) => allowedSet.has(item));
}
function enumListWithWarnings(value, allowed, key, warnings) {
    const raw = list(value);
    const allowedSet = new Set(allowed);
    for (const item of raw) {
        if (!allowedSet.has(item))
            warnings.push({ key: `${key}:${item}`, reason: 'invalid' });
    }
    return raw.filter((item) => allowedSet.has(item));
}
function codeList(value) {
    return [...new Set(list(value).map((item) => item.toUpperCase()))];
}
function keywordTerms(value, warnings) {
    const values = Array.isArray(value) ? value : value == null ? [] : [value];
    const terms = [];
    const seen = new Set();
    for (const raw of values) {
        if (typeof raw !== 'string' || !raw.trim() || raw.trim().length > 120) {
            warnings.push({ key: 'keywordTerms', reason: 'invalid' });
            continue;
        }
        const term = text(raw);
        const key = term.toLocaleLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            terms.push(term);
        }
    }
    if (terms.length > exports.MAX_OPPORTUNITY_KEYWORD_TERMS) {
        warnings.push({ key: 'keywordTerms', reason: 'invalid' });
        return terms.slice(0, exports.MAX_OPPORTUNITY_KEYWORD_TERMS);
    }
    return terms;
}
function isoOrNull(value) {
    const candidate = text(value);
    if (!candidate)
        return null;
    const parsed = Date.parse(candidate);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function normalizeOpportunitySearchCriteria(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const warnings = [];
    const unsupported = {};
    const storedSchemaVersion = raw.schemaVersion;
    if (typeof storedSchemaVersion === 'number' &&
        Number.isFinite(storedSchemaVersion) &&
        storedSchemaVersion > 2) {
        warnings.push({ key: 'schemaVersion', reason: 'unsupported' });
        unsupported.schemaVersion = storedSchemaVersion;
    }
    for (const [key, value] of Object.entries(raw)) {
        if (!SUPPORTED_KEYS.has(key) && value !== undefined) {
            warnings.push({ key, reason: 'unsupported' });
            unsupported[key] = value;
        }
    }
    const mode = exports.OPPORTUNITY_SEARCH_MODES.includes(raw.mode)
        ? raw.mode
        : DEFAULT_CRITERIA.mode;
    const queryMatch = exports.OPPORTUNITY_QUERY_MATCHES_V2.includes(raw.queryMatch)
        ? raw.queryMatch
        : undefined;
    const lifecycleProvided = raw.lifecycle !== undefined;
    const lifecycle = enumListWithWarnings(raw.lifecycle, exports.OPPORTUNITY_LIFECYCLES_V2, 'lifecycle', warnings);
    const sort = exports.OPPORTUNITY_SORTS_V2.includes(raw.sort)
        ? raw.sort
        : DEFAULT_CRITERIA.sort;
    const deadlineWindow = ['any', '14d', '30d', '90d', '180d'].includes(String(raw.deadlineWindow))
        ? String(raw.deadlineWindow)
        : DEFAULT_CRITERIA.deadlineWindow;
    const direction = raw.direction === 'desc' ? 'desc' : 'asc';
    const page = Math.min(Math.max(Number(raw.page) || 1, 1), 10_000);
    const pageSize = Math.min(Math.max(Number(raw.pageSize) || 20, 1), 100);
    const client = text(raw.clientId);
    const criteria = {
        schemaVersion: 2,
        mode,
        clientId: client || null,
        query: text(raw.query),
        ...(queryMatch ? { queryMatch } : {}),
        keywordTerms: keywordTerms(raw.keywordTerms, warnings),
        sources: enumListWithWarnings(raw.sources, exports.OPPORTUNITY_SOURCES_V2, 'sources', warnings),
        types: enumListWithWarnings(raw.types, exports.OPPORTUNITY_TYPES_V2, 'types', warnings),
        lifecycle: lifecycleProvided ? lifecycle : DEFAULT_CRITERIA.lifecycle,
        agencies: list(raw.agencies),
        sectors: list(raw.sectors),
        naicsCodes: codeList(raw.naicsCodes),
        pscCodes: codeList(raw.pscCodes),
        setAsideCodes: codeList(raw.setAsideCodes),
        eligibility: enumListWithWarnings(raw.eligibility, ['eligible', 'ineligible', 'needs_review', 'unknown'], 'eligibility', warnings),
        posted: enumListWithWarnings(raw.posted, ['last_7_days', 'last_30_days', 'last_90_days', 'this_fiscal_year', 'any'], 'posted', warnings),
        geography: list(raw.geography),
        applicantTypes: list(raw.applicantTypes),
        funding: list(raw.funding),
        costShare: list(raw.costShare),
        methods: list(raw.methods),
        disbursement: list(raw.disbursement),
        grantPrerequisites: list(raw.grantPrerequisites),
        codes: codeList(raw.codes),
        deadlineWindow,
        deadlineFrom: isoOrNull(raw.deadlineFrom),
        deadlineTo: isoOrNull(raw.deadlineTo),
        sort,
        direction,
        page,
        pageSize,
    };
    if (raw.mode !== undefined && mode !== raw.mode)
        warnings.push({ key: 'mode', reason: 'invalid' });
    if (raw.queryMatch !== undefined && queryMatch === undefined)
        warnings.push({ key: 'queryMatch', reason: 'invalid' });
    if (queryMatch && criteria.query.length > 512)
        warnings.push({ key: 'query', reason: 'invalid' });
    if (queryMatch === 'keywords' &&
        new Set((criteria.query.match(/"([^"]*)"|(\S+)/g) ?? [])
            .map((term) => term.replace(/^"|"$/g, '').trim().toLowerCase())
            .filter(Boolean)).size > 20)
        warnings.push({ key: 'query', reason: 'invalid' });
    if (lifecycleProvided &&
        lifecycle.length === 0 &&
        Array.isArray(raw.lifecycle) &&
        raw.lifecycle.length > 0)
        warnings.push({ key: 'lifecycle', reason: 'invalid' });
    if (raw.sort !== undefined && sort !== raw.sort)
        warnings.push({ key: 'sort', reason: 'invalid' });
    if (raw.deadlineWindow !== undefined && deadlineWindow !== raw.deadlineWindow)
        warnings.push({ key: 'deadlineWindow', reason: 'invalid' });
    if (raw.deadlineFrom != null && criteria.deadlineFrom == null)
        warnings.push({ key: 'deadlineFrom', reason: 'invalid' });
    if (raw.deadlineTo != null && criteria.deadlineTo == null)
        warnings.push({ key: 'deadlineTo', reason: 'invalid' });
    return { criteria, warnings, unsupported };
}
//# sourceMappingURL=funding-opportunities-v2.js.map