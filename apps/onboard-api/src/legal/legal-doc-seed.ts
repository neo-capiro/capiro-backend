/**
 * ⚠️ COUNSEL-PENDING DRAFTS (Ninja decision Q7, 2026-07-06).
 *
 * This is the onboarding prototype's placeholder legal text
 * (apps/onboard-web/prototype/02-flow1.jsx — OB_TOS_TEXT / OB_MSA_TEXT),
 * versioned and seeded so the consent mechanics work end-to-end BEFORE counsel
 * delivers the real documents. When counsel-approved text lands, seed it as a
 * NEW version — never edit a shipped version in place, because
 * onboard_consent rows reference doc versions immutably (SOC 2 evidence).
 *
 * Per the Gherkin copy rule the document is titled "Subscription Agreement"
 * (SA) — the strings "MSA" / "Master Subscription Agreement" must not appear.
 */

export const LEGAL_SEED_VERSION = '2026.07-draft1';

interface LegalSection {
  heading?: string;
  body: string;
}

function sectionsToHtml(sections: LegalSection[]): string {
  return sections
    .map((s) => (s.heading ? `<h3>${s.heading}</h3><p>${s.body}</p>` : `<p>${s.body}</p>`))
    .join('\n');
}

// Verbatim paragraphs from the prototype's OB_TOS_TEXT.
const TOS_SECTIONS: LegalSection[] = [
  {
    heading: '1. ACCEPTANCE OF TERMS',
    body: 'By accessing or using the Capiro platform, you agree to be bound by these Terms of Service.',
  },
  {
    heading: '2. USE OF SERVICE',
    body: 'Capiro grants your organization a non-exclusive, non-transferable right to access the platform for internal business purposes.',
  },
  {
    heading: '3. ACCOUNTS',
    body: "You are responsible for maintaining the confidentiality of credentials and for all activity under your organization's accounts.",
  },
  {
    heading: '4. DATA',
    body: 'Client data you import remains yours. Capiro processes it solely to provide the service.',
  },
  {
    heading: '5. ACCEPTABLE USE',
    body: 'You will not misuse the service, attempt unauthorized access, or resell access without written consent.',
  },
  {
    heading: '6. TERMINATION',
    body: 'Either party may terminate per the Subscription Agreement. Sections that by nature survive termination will survive.',
  },
];

// Verbatim paragraphs from the prototype's OB_MSA_TEXT (retitled "Subscription
// Agreement" per the copy rule — the prototype body already uses that name).
const SA_SECTIONS: LegalSection[] = [
  {
    heading: '1. SUBSCRIPTION',
    body: 'Capiro provides the platform on a per-client-profile subscription basis, at the tier selected at purchase.',
  },
  {
    heading: '2. FEES & PAYMENT',
    body: 'Fees are billed monthly in advance. Trial accounts convert automatically on day 31 unless cancelled. Wire and ACH invoices are due on receipt.',
  },
  {
    heading: '3. PROFILE CAPACITY',
    body: 'Your organization may hold at most the number of active client profiles purchased. Capacity changes take effect on payment.',
  },
  {
    heading: '4. SERVICE LEVELS',
    body: 'Capiro targets 99.9% monthly availability, excluding scheduled maintenance.',
  },
  {
    heading: '5. CONFIDENTIALITY',
    body: "Each party protects the other's confidential information with reasonable care.",
  },
  {
    heading: '6. LIABILITY',
    body: "Neither party's aggregate liability exceeds fees paid in the trailing 12 months.",
  },
];

// Plan-variant preambles (SA text is tailored to the chosen plan).
const SA_TRIAL_PREAMBLE: LegalSection = {
  body:
    'TRIAL TERMS. This Subscription Agreement governs a 30-day free trial. No fees are charged today. ' +
    'Unless you cancel before day 31, your trial converts automatically to a paid monthly subscription on day 31, ' +
    'billed to the payment method placed on file at signup at the tier selected.',
};

const SA_PAID_PREAMBLE: LegalSection = {
  body:
    'PAID SUBSCRIPTION TERMS. This Subscription Agreement governs a paid subscription that begins immediately at purchase. ' +
    'Your first billing cycle starts on the date of purchase, and fees for the selected client-profile tier are billed monthly in advance from that date.',
};

export interface LegalDocSeed {
  docType: 'tos' | 'sa';
  planVariant: 'all' | 'trial' | 'paid';
  version: string;
  html: string;
}

export const LEGAL_DOC_SEEDS: LegalDocSeed[] = [
  {
    docType: 'tos',
    planVariant: 'all',
    version: LEGAL_SEED_VERSION,
    html: sectionsToHtml(TOS_SECTIONS),
  },
  {
    docType: 'sa',
    planVariant: 'trial',
    version: LEGAL_SEED_VERSION,
    html: sectionsToHtml([SA_TRIAL_PREAMBLE, ...SA_SECTIONS]),
  },
  {
    docType: 'sa',
    planVariant: 'paid',
    version: LEGAL_SEED_VERSION,
    html: sectionsToHtml([SA_PAID_PREAMBLE, ...SA_SECTIONS]),
  },
];
