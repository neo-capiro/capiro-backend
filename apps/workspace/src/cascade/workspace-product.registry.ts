/**
 * Canonical Workspace product descriptors and one-time compatibility projections.
 * Projection ranks preserve each original map/list order independently. The
 * objects and arrays remain mutable; projections retain descriptor references.
 */
import type { ProductMeta } from './cascade.config.js';

type WorkspaceProductProjection =
  'metadata' | 'sections' | 'pages' | 'canonical' | 'universal' | 'funding';
type WorkspaceProductKey =
  | 'whitePaper'
  | 'appropriationsJustification'
  | 'ndaaAuthorizationRequest'
  | 'meetingBriefAdvocacy'
  | 'cdsEarmarkApplication'
  | 'authorizationBillLanguage'
  | 'reportLanguageRequest'
  | 'memberLetter'
  | 'strategyMemo'
  | 'writtenTestimony'
  | 'onePager';

interface WorkspaceProductDescriptor {
  name: string;
  metadata: ProductMeta;
  sections: string[];
  pages: number;
  orders: Record<WorkspaceProductProjection, number | null>;
}

export const WORKSPACE_PRODUCT_REGISTRY: Record<WorkspaceProductKey, WorkspaceProductDescriptor> = {
  whitePaper: {
    name: 'White paper',
    metadata: {
      icon: 'FileText',
      personalize: false,
      office: true,
      cover: false,
      desc: 'Narrative program paper supporting authorization, appropriations, or policy asks.',
    },
    sections: [
      'Problem statement',
      'Solution',
      'Current status',
      'Funding history & request',
      'National security impact',
      'Economic & district impact',
      'The ask',
    ],
    pages: 2,
    orders: { metadata: 0, sections: 10, pages: 0, canonical: null, universal: null, funding: 0 },
  },
  appropriationsJustification: {
    name: 'Appropriations Justification',
    metadata: {
      icon: 'Coins',
      personalize: false,
      office: true,
      cover: true,
      desc: "Detail a program's funding need and justification.",
    },
    sections: [
      'Executive summary',
      'Account & program line',
      'Program description',
      'Funding history',
      'Justification & impact',
      'Performance & outcomes',
      'The ask',
    ],
    pages: 2,
    orders: { metadata: 1, sections: 1, pages: 1, canonical: 1, universal: null, funding: 1 },
  },
  ndaaAuthorizationRequest: {
    name: 'NDAA Authorization Request',
    metadata: {
      icon: 'TrendingUp',
      personalize: false,
      office: true,
      cover: true,
      desc: 'Request program authorization or a budget adjustment.',
    },
    sections: [
      'Problem statement',
      'Solution',
      'Current status',
      'Funding history & request',
      'National security impact',
      'Economic & district impact',
      'The ask',
    ],
    pages: 2,
    orders: { metadata: 2, sections: 0, pages: 2, canonical: 0, universal: null, funding: 2 },
  },
  meetingBriefAdvocacy: {
    name: 'Meeting Brief & Advocacy',
    metadata: {
      icon: 'Users',
      personalize: false,
      office: true,
      cover: false,
      desc: 'Leave-behind brief for a member or staff meeting.',
    },
    sections: [
      'Meeting logistics',
      'Member profile',
      'Background',
      'Objectives & the ask',
      'Talking points',
      'Anticipated questions & responses',
      'Leave-behind summary',
      'Follow-up plan',
    ],
    pages: 1,
    orders: { metadata: 3, sections: 5, pages: 3, canonical: 5, universal: null, funding: null },
  },
  cdsEarmarkApplication: {
    name: 'CDS / Earmark Application',
    metadata: {
      icon: 'Landmark',
      personalize: true,
      office: true,
      cover: true,
      desc: 'Community project funding application.',
    },
    sections: [
      'Requesting entity & recipient information',
      'Project title',
      'Project description',
      'Requested amount & total cost',
      'Federal nexus statement',
      'Evidence of community support',
      'Financial disclosure certification',
      'Outcomes & metrics',
    ],
    pages: 2,
    orders: { metadata: 4, sections: 2, pages: 8, canonical: 2, universal: null, funding: 3 },
  },
  authorizationBillLanguage: {
    name: 'Authorization Bill Language',
    metadata: {
      icon: 'Scale',
      personalize: false,
      office: false,
      cover: false,
      desc: 'Amendatory statutory / authorizing text.',
    },
    sections: [
      'Short title',
      'Findings & purpose',
      'Definitions',
      'Main operative provision',
      'Exceptions & special rules',
      'Conforming & transitional provisions',
      'Authorization of appropriations',
      'Effective date',
    ],
    pages: 3,
    orders: { metadata: 5, sections: 3, pages: 9, canonical: 3, universal: null, funding: null },
  },
  reportLanguageRequest: {
    name: 'Report Language Request',
    metadata: {
      icon: 'FileSignature',
      personalize: false,
      office: false,
      cover: false,
      desc: 'Directive or encouraging committee report language.',
    },
    sections: [
      'Requesting entity & contact',
      'Bill, account & subcommittee',
      'Background & problem',
      'Proposed report language',
      'Justification',
      'Relationship to existing law & PBR',
    ],
    pages: 1,
    orders: { metadata: 6, sections: 4, pages: 10, canonical: 4, universal: null, funding: null },
  },
  memberLetter: {
    name: 'Member letter',
    metadata: {
      icon: 'Mail',
      personalize: true,
      office: true,
      cover: false,
      desc: 'Cosponsor request, support letter, or consolidated sign-on letter to a Member.',
    },
    sections: ['Opening', 'Program description', 'Request', 'Closing'],
    pages: 1,
    orders: { metadata: 7, sections: 6, pages: 5, canonical: 6, universal: 0, funding: null },
  },
  strategyMemo: {
    name: 'Strategy memo',
    metadata: {
      icon: 'ClipboardList',
      personalize: false,
      office: false,
      cover: false,
      desc: 'Internal brief covering situation analysis and strategic recommendation.',
    },
    sections: ['Situation', 'Background', 'Analysis', 'Recommendation', 'Next steps'],
    pages: 2,
    orders: { metadata: 8, sections: 9, pages: 4, canonical: 9, universal: 3, funding: null },
  },
  writtenTestimony: {
    name: 'Written testimony',
    metadata: {
      icon: 'Mic',
      personalize: false,
      office: false,
      cover: false,
      desc: 'Statement for the record before a committee or agency.',
    },
    sections: [
      'Disclosure & witness intro',
      'Opening statement',
      'Background',
      'Position',
      'Recommendations',
      'Closing',
    ],
    pages: 5,
    orders: { metadata: 9, sections: 7, pages: 6, canonical: 7, universal: 1, funding: null },
  },
  onePager: {
    name: 'One-pager',
    metadata: {
      icon: 'File',
      personalize: false,
      office: true,
      cover: false,
      desc: 'Meeting leave-behind or fact sheet summarizing the program and ask.',
    },
    sections: [
      'Header & title',
      'Background',
      'Key facts & data',
      'Our position & the ask',
      'Contact information',
    ],
    pages: 1,
    orders: { metadata: 10, sections: 8, pages: 7, canonical: 8, universal: 2, funding: null },
  },
};

function workspaceProductsInOrder(
  projection: WorkspaceProductProjection,
): WorkspaceProductDescriptor[] {
  return Object.values(WORKSPACE_PRODUCT_REGISTRY)
    .filter((product) => product.orders[projection] !== null)
    .sort((left, right) => (left.orders[projection] ?? 0) - (right.orders[projection] ?? 0));
}

export const WORKSPACE_PRODUCT_METADATA: Record<string, ProductMeta> = Object.fromEntries(
  workspaceProductsInOrder('metadata').map((product) => [product.name, product.metadata]),
);
export const WORKSPACE_PRODUCT_SECTIONS: Record<string, string[]> = Object.fromEntries(
  workspaceProductsInOrder('sections').map((product) => [product.name, product.sections]),
);
export const WORKSPACE_PRODUCT_PAGES: Record<string, number> = Object.fromEntries(
  workspaceProductsInOrder('pages').map((product) => [product.name, product.pages]),
);
export const WORKSPACE_PRODUCT_CANONICAL = workspaceProductsInOrder('canonical').map(
  (product) => product.name,
);
export const WORKSPACE_PRODUCT_UNIVERSAL = workspaceProductsInOrder('universal').map(
  (product) => product.name,
);
export const WORKSPACE_PRODUCT_FUNDING = workspaceProductsInOrder('funding').map(
  (product) => product.name,
);
