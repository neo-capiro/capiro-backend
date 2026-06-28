/**
 * Workspace engine cascade + product configuration.
 *
 * Ported verbatim from the locked prototype `ui_kits/workspace/wsconfig.jsx`
 * (the Sankey cascade, PRODUCT_META, FUNDING_PRODUCTS, SUGGESTED_SECTIONS,
 * SUGGESTED_PAGES) and `wsdata.jsx` (INDUSTRY_DATA, sectionLibrary). This is the
 * authoritative server-side source of truth for the intake cascade; the API
 * exposes it via /workspace-api/cascade and /workspace-api/products/:p/defaults.
 *
 * Source of truth: WORKSPACE-ENGINE.md §2 (cascade) + Handoff Brief.
 */

export interface CascadeProduct {
  name: string;
  pathways: string[];
}

export interface CascadeIndustry {
  industry: string;
  products: CascadeProduct[];
  pathways: Record<string, string[]>; // pathway -> committees
}

// ── The Sankey cascade, as data (wsconfig.jsx CASCADE) ──────────────────────
export const CASCADE: CascadeIndustry[] = [
  {
    industry: 'Defense & Aerospace',
    products: [
      { name: 'NDAA Authorization Request', pathways: ['NDAA Authorization'] },
      {
        name: 'Meeting Brief & Advocacy',
        pathways: ['NDAA Authorization', 'Defense Appropriations'],
      },
      { name: 'Appropriations Justification', pathways: ['Defense Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['Defense Appropriations'] },
    ],
    pathways: {
      'NDAA Authorization': ['HASC', 'SASC'],
      'Defense Appropriations': ['HAC-D', 'SAC-D'],
    },
  },
  {
    industry: 'Health & Pharma',
    products: [
      { name: 'Appropriations Justification', pathways: ['Labor-HHS Appropriations'] },
      {
        name: 'Meeting Brief & Advocacy',
        pathways: ['Labor-HHS Appropriations', 'HELP Authorization'],
      },
      { name: 'Authorization Bill Language', pathways: ['HELP Authorization'] },
    ],
    pathways: { 'Labor-HHS Appropriations': ['L-HHS'], 'HELP Authorization': ['HELP'] },
  },
  {
    industry: 'Energy & Resources',
    products: [
      { name: 'Appropriations Justification', pathways: ['Energy & Water Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['ENR Authorization'] },
    ],
    pathways: { 'Energy & Water Appropriations': ['E&W'], 'ENR Authorization': ['ENR'] },
  },
  {
    industry: 'Agriculture',
    products: [
      { name: 'Appropriations Justification', pathways: ['Agriculture Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['Farm Bill Authorization'] },
    ],
    pathways: {
      'Agriculture Appropriations': ['HAC-Ag'],
      'Farm Bill Authorization': ['Senate Ag'],
    },
  },
  {
    industry: 'Transportation',
    products: [
      { name: 'Appropriations Justification', pathways: ['T-HUD Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['T-HUD Appropriations'] },
    ],
    pathways: { 'T-HUD Appropriations': ['T-HUD', 'T&I'] },
  },
  {
    industry: 'Homeland Security',
    products: [
      { name: 'Appropriations Justification', pathways: ['Homeland Security Appropriations'] },
      { name: 'Authorization Bill Language', pathways: ['Homeland Security Appropriations'] },
    ],
    pathways: { 'Homeland Security Appropriations': ['HAC-HS', 'SAC-HS'] },
  },
  {
    industry: 'Environment',
    products: [
      { name: 'Appropriations Justification', pathways: ['Interior & Environment Appropriations'] },
      { name: 'CDS / Earmark Application', pathways: ['Interior & Environment Appropriations'] },
    ],
    pathways: { 'Interior & Environment Appropriations': ['Int/Env', 'EPW'] },
  },
  {
    industry: 'Commerce & Tech',
    products: [
      { name: 'Appropriations Justification', pathways: ['CJS Appropriations'] },
      { name: 'Report Language Request', pathways: ['CJS Appropriations'] },
    ],
    pathways: { 'CJS Appropriations': ['CJS', 'Commerce', 'Science'] },
  },
];

// White paper is a universal work product (m0168); plus generic comms docs
// always offered in the full list.
export const UNIVERSAL_PRODUCTS = [
  'Member letter',
  'Written testimony',
  'One-pager',
  'Strategy memo',
];

// The 10 canonical work products (Handoff Brief). White paper + the 6 formal
// + the rest. Used by allLibraryProducts() for the "Other work product" picker.
export const CANONICAL_PRODUCTS = [
  'NDAA Authorization Request',
  'Appropriations Justification',
  'CDS / Earmark Application',
  'Authorization Bill Language',
  'Report Language Request',
  'Meeting Brief & Advocacy',
  'Member letter',
  'Written testimony',
  'One-pager',
  'Strategy memo',
];

// Funding products: carry a dollar ask; cfg.ask is relevant. Non-funding = "n/a".
export const FUNDING_PRODUCTS = [
  'White paper',
  'Appropriations Justification',
  'NDAA Authorization Request',
  'CDS / Earmark Application',
];

export interface ProductMeta {
  icon: string;
  personalize: boolean;
  office: boolean;
  cover: boolean;
  desc: string;
}

// Work-product metadata: icon + personalization defaults (wsconfig.jsx PRODUCT_META).
export const PRODUCT_META: Record<string, ProductMeta> = {
  'White paper': {
    icon: 'FileText',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Narrative program paper supporting authorization, appropriations, or policy asks.',
  },
  'Appropriations Justification': {
    icon: 'Coins',
    personalize: false,
    office: true,
    cover: true,
    desc: "Detail a program's funding need and justification.",
  },
  'NDAA Authorization Request': {
    icon: 'TrendingUp',
    personalize: false,
    office: true,
    cover: true,
    desc: 'Request program authorization or a budget adjustment.',
  },
  'Meeting Brief & Advocacy': {
    icon: 'Users',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Leave-behind brief for a member or staff meeting.',
  },
  'CDS / Earmark Application': {
    icon: 'Landmark',
    personalize: true,
    office: true,
    cover: true,
    desc: 'Community project funding application.',
  },
  'Authorization Bill Language': {
    icon: 'Scale',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Amendatory statutory / authorizing text.',
  },
  'Report Language Request': {
    icon: 'FileSignature',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Directive or encouraging committee report language.',
  },
  'Member letter': {
    icon: 'Mail',
    personalize: true,
    office: true,
    cover: false,
    desc: 'Cosponsor request, support letter, or consolidated sign-on letter to a Member.',
  },
  'Strategy memo': {
    icon: 'ClipboardList',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Internal brief covering situation analysis and strategic recommendation.',
  },
  'Written testimony': {
    icon: 'Mic',
    personalize: false,
    office: false,
    cover: false,
    desc: 'Statement for the record before a committee or agency.',
  },
  'One-pager': {
    icon: 'File',
    personalize: false,
    office: true,
    cover: false,
    desc: 'Meeting leave-behind or fact sheet summarizing the program and ask.',
  },
};

// Relevant platform data per industry (wsdata INDUSTRY_DATA) — Defense budget
// identifiers etc. Toggled into cfg.linkedData[] in Setup.
export interface IndustryDatum {
  label: string;
  value: string;
  icon: string;
}
export const INDUSTRY_DATA: Record<string, IndustryDatum[]> = {
  'Defense & Aerospace': [
    { label: 'Program Element (PE)', value: '0603563N', icon: 'Database' },
    { label: 'R-1 budget line', value: '098', icon: 'FileText' },
    { label: 'Navy UPL listing', value: 'FY27 #21', icon: 'ListOrdered' },
  ],
  'Health & Pharma': [
    { label: 'Budget account', value: 'Labor-HHS', icon: 'Database' },
    { label: 'Authorizing authority', value: 'PHSA', icon: 'Scale' },
  ],
  'Energy & Resources': [{ label: 'DOE program office', value: 'EERE', icon: 'Database' }],
  Agriculture: [{ label: 'USDA program code', value: '', icon: 'Database' }],
  Transportation: [{ label: 'DOT program', value: '', icon: 'Database' }],
};

// Suggested sections per work product (wsconfig.jsx SUGGESTED_SECTIONS).
export const SUGGESTED_SECTIONS: Record<string, string[]> = {
  'NDAA Authorization Request': [
    'Problem statement',
    'Solution',
    'Current status',
    'Funding history & request',
    'National security impact',
    'Economic & district impact',
    'The ask',
  ],
  'Appropriations Justification': [
    'Executive summary',
    'Account & program line',
    'Program description',
    'Funding history',
    'Justification & impact',
    'Performance & outcomes',
    'The ask',
  ],
  'CDS / Earmark Application': [
    'Requesting entity & recipient information',
    'Project title',
    'Project description',
    'Requested amount & total cost',
    'Federal nexus statement',
    'Evidence of community support',
    'Financial disclosure certification',
    'Outcomes & metrics',
  ],
  'Authorization Bill Language': [
    'Short title',
    'Findings & purpose',
    'Definitions',
    'Main operative provision',
    'Exceptions & special rules',
    'Conforming & transitional provisions',
    'Authorization of appropriations',
    'Effective date',
  ],
  'Report Language Request': [
    'Requesting entity & contact',
    'Bill, account & subcommittee',
    'Background & problem',
    'Proposed report language',
    'Justification',
    'Relationship to existing law & PBR',
  ],
  'Meeting Brief & Advocacy': [
    'Meeting logistics',
    'Member profile',
    'Background',
    'Objectives & the ask',
    'Talking points',
    'Anticipated questions & responses',
    'Leave-behind summary',
    'Follow-up plan',
  ],
  'Member letter': ['Opening', 'Program description', 'Request', 'Closing'],
  'Written testimony': [
    'Disclosure & witness intro',
    'Opening statement',
    'Background',
    'Position',
    'Recommendations',
    'Closing',
  ],
  'One-pager': [
    'Header & title',
    'Background',
    'Key facts & data',
    'Our position & the ask',
    'Contact information',
  ],
  'Strategy memo': ['Situation', 'Background', 'Analysis', 'Recommendation', 'Next steps'],
  'White paper': [
    'Problem statement',
    'Solution',
    'Current status',
    'Funding history & request',
    'National security impact',
    'Economic & district impact',
    'The ask',
  ],
};

// Suggested page length per work product (wsconfig.jsx SUGGESTED_PAGES).
export const SUGGESTED_PAGES: Record<string, number> = {
  'White paper': 2,
  'Appropriations Justification': 2,
  'NDAA Authorization Request': 2,
  'Meeting Brief & Advocacy': 1,
  'Strategy memo': 2,
  'Member letter': 1,
  'Written testimony': 5,
  'One-pager': 1,
  'CDS / Earmark Application': 2,
  'Authorization Bill Language': 3,
  'Report Language Request': 1,
};

// Section library for "write your own" / add-from-library (wsdata sectionLibrary).
export const SECTION_LIBRARY = [
  'BLUF',
  'Operational need',
  'Strategy & COCOM alignment',
  'UPL / UFR status',
  'Execution rationale',
  'Endorsements & attachments',
  'Precedent',
  'Certifications',
  'Contact block',
];

// ── Per-section drafting spec (E-4) ─────────────────────────────────────────
// Gives Meri a length + goal + FORMAT per section so it stops emitting one
// generic prose block for every section. Keyed by section NAME via a keyword
// classifier so it also covers library/custom/renamed sections.
export interface SectionSpec {
  goal: string;
  format: 'prose' | 'bullets' | 'short' | 'table';
  targetWords: [number, number];
}

export function sectionSpecFor(name: string): SectionSpec {
  const n = (name || '').toLowerCase();
  if (/\bthe ask\b|^ask\b|\btitle\b|effective date|^opening|^closing|letterhead|header/.test(n))
    return { goal: 'State this directly and briefly.', format: 'short', targetWords: [10, 40] };
  if (/funding history|budget|requested amount|total cost|funding ask|appropriation amount/.test(n))
    return {
      goal: 'Present the budget figures by fiscal year.',
      format: 'table',
      targetWords: [20, 90],
    };
  if (
    /talking points|key facts|recommendation|next steps|objective|outcomes|metrics|anticipated questions|q&a|questions & responses/.test(
      n,
    )
  )
    return { goal: 'List the key points concisely.', format: 'bullets', targetWords: [40, 150] };
  if (
    /contact|logistics|disclosure|certification|account & program|recipient information|requesting entity|witness/.test(
      n,
    )
  )
    return {
      goal: 'Provide the specific factual details, briefly.',
      format: 'short',
      targetWords: [15, 70],
    };
  if (
    /operative provision|definitions|exceptions|authorization of appropriations|report language|bill language/.test(
      n,
    )
  )
    return {
      goal: 'Draft in precise legislative/statutory drafting register.',
      format: 'prose',
      targetWords: [60, 220],
    };
  if (/executive summary|^summary|bluf|abstract/.test(n))
    return {
      goal: 'Summarize the core message up front.',
      format: 'prose',
      targetWords: [80, 140],
    };
  if (
    /analysis|position|justification|background|impact|problem|solution|program description|rationale|need/.test(
      n,
    )
  )
    return {
      goal: 'Develop the argument with specifics and supporting evidence.',
      format: 'prose',
      targetWords: [150, 280],
    };
  return {
    goal: 'Develop this section clearly and specifically.',
    format: 'prose',
    targetWords: [120, 220],
  };
}

// ── Cascade query helpers (wsconfig.jsx WSC) ────────────────────────────────
export const WSC = {
  industries: (): string[] => CASCADE.map((c) => c.industry),
  _ind: (industry: string): CascadeIndustry | undefined =>
    CASCADE.find((c) => c.industry === industry),
  productsFor(industry: string): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    return [...new Set([...ind.products.map((p) => p.name), ...UNIVERSAL_PRODUCTS])];
  },
  pathwaysFor(industry: string, product: string): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    if (UNIVERSAL_PRODUCTS.includes(product)) return Object.keys(ind.pathways);
    const p = ind.products.find((x) => x.name === product);
    return p ? p.pathways : Object.keys(ind.pathways);
  },
  committeesFor(industry: string, pathways: string[]): string[] {
    const ind = this._ind(industry);
    if (!ind) return [];
    const out: string[] = [];
    (pathways || []).forEach((pw) =>
      (ind.pathways[pw] || []).forEach((c) => out.includes(c) || out.push(c)),
    );
    return out;
  },
  meta: (product: string): ProductMeta =>
    PRODUCT_META[product] || {
      icon: 'FileText',
      personalize: false,
      office: true,
      cover: true,
      desc: '',
    },
  // Library grid + "other work product" picker. White paper is offered as its
  // own card (product owner decision Q-LIB-A) alongside the 10 canonical.
  allLibraryProducts: (): string[] => ['White paper', ...CANONICAL_PRODUCTS],
  dataFor: (industry: string): IndustryDatum[] => INDUSTRY_DATA[industry] || [],
  isFunding: (product: string): boolean => FUNDING_PRODUCTS.includes(product),
  suggestedSections(product: string): string[] {
    return (SUGGESTED_SECTIONS[product] || ['Summary', 'Background', 'The ask']).slice();
  },
  suggestedPages: (product: string): number => SUGGESTED_PAGES[product] || 2,
  specFor: (section: string): SectionSpec => sectionSpecFor(section),
};
