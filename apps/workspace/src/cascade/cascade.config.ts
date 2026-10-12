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

import {
  WORKSPACE_PRODUCT_REGISTRY,
  WORKSPACE_PRODUCT_METADATA,
  WORKSPACE_PRODUCT_SECTIONS,
  WORKSPACE_PRODUCT_PAGES,
  WORKSPACE_PRODUCT_CANONICAL,
  WORKSPACE_PRODUCT_UNIVERSAL,
  WORKSPACE_PRODUCT_FUNDING,
} from './workspace-product.registry.js';

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
      { name: WORKSPACE_PRODUCT_REGISTRY.ndaaAuthorizationRequest.name, pathways: ['NDAA Authorization'] },
      {
        name: WORKSPACE_PRODUCT_REGISTRY.meetingBriefAdvocacy.name,
        pathways: ['NDAA Authorization', 'Defense Appropriations'],
      },
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Defense Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.cdsEarmarkApplication.name, pathways: ['Defense Appropriations'] },
    ],
    pathways: {
      'NDAA Authorization': ['HASC', 'SASC'],
      'Defense Appropriations': ['HAC-D', 'SAC-D'],
    },
  },
  {
    industry: 'Health & Pharma',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Labor-HHS Appropriations'] },
      {
        name: WORKSPACE_PRODUCT_REGISTRY.meetingBriefAdvocacy.name,
        pathways: ['Labor-HHS Appropriations', 'HELP Authorization'],
      },
      { name: WORKSPACE_PRODUCT_REGISTRY.authorizationBillLanguage.name, pathways: ['HELP Authorization'] },
    ],
    pathways: { 'Labor-HHS Appropriations': ['L-HHS'], 'HELP Authorization': ['HELP'] },
  },
  {
    industry: 'Energy & Resources',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Energy & Water Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.authorizationBillLanguage.name, pathways: ['ENR Authorization'] },
    ],
    pathways: { 'Energy & Water Appropriations': ['E&W'], 'ENR Authorization': ['ENR'] },
  },
  {
    industry: 'Agriculture',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Agriculture Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.authorizationBillLanguage.name, pathways: ['Farm Bill Authorization'] },
    ],
    pathways: {
      'Agriculture Appropriations': ['HAC-Ag'],
      'Farm Bill Authorization': ['Senate Ag'],
    },
  },
  {
    industry: 'Transportation',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['T-HUD Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.cdsEarmarkApplication.name, pathways: ['T-HUD Appropriations'] },
    ],
    pathways: { 'T-HUD Appropriations': ['T-HUD', 'T&I'] },
  },
  {
    industry: 'Homeland Security',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Homeland Security Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.authorizationBillLanguage.name, pathways: ['Homeland Security Appropriations'] },
    ],
    pathways: { 'Homeland Security Appropriations': ['HAC-HS', 'SAC-HS'] },
  },
  {
    industry: 'Environment',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['Interior & Environment Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.cdsEarmarkApplication.name, pathways: ['Interior & Environment Appropriations'] },
    ],
    pathways: { 'Interior & Environment Appropriations': ['Int/Env', 'EPW'] },
  },
  {
    industry: 'Commerce & Tech',
    products: [
      { name: WORKSPACE_PRODUCT_REGISTRY.appropriationsJustification.name, pathways: ['CJS Appropriations'] },
      { name: WORKSPACE_PRODUCT_REGISTRY.reportLanguageRequest.name, pathways: ['CJS Appropriations'] },
    ],
    pathways: { 'CJS Appropriations': ['CJS', 'Commerce', 'Science'] },
  },
];

// White paper is a universal work product (m0168); plus generic comms docs
// always offered in the full list.
export const UNIVERSAL_PRODUCTS = WORKSPACE_PRODUCT_UNIVERSAL;

// The 10 canonical work products (Handoff Brief). White paper + the 6 formal
// + the rest. Used by allLibraryProducts() for the "Other work product" picker.
export const CANONICAL_PRODUCTS = WORKSPACE_PRODUCT_CANONICAL;

// Funding products: carry a dollar ask; cfg.ask is relevant. Non-funding = "n/a".
export const FUNDING_PRODUCTS = WORKSPACE_PRODUCT_FUNDING;

export interface ProductMeta {
  icon: string;
  personalize: boolean;
  office: boolean;
  cover: boolean;
  desc: string;
}

// Work-product metadata: icon + personalization defaults (wsconfig.jsx PRODUCT_META).
export const PRODUCT_META: Record<string, ProductMeta> = WORKSPACE_PRODUCT_METADATA;

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
export const SUGGESTED_SECTIONS: Record<string, string[]> = WORKSPACE_PRODUCT_SECTIONS;

// Suggested page length per work product (wsconfig.jsx SUGGESTED_PAGES).
export const SUGGESTED_PAGES: Record<string, number> = WORKSPACE_PRODUCT_PAGES;

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
