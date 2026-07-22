/**
 * Active legal documents (Flow 1.5) — the versioned ToS + Subscription
 * Agreement shown on the /legal step and attested by the e-signature ceremony.
 *
 * The on-screen HTML is AUTO-GENERATED from the counsel-provided source text in
 * src/legal/assets/*.txt (see legal-doc-content.ts + scripts/build-legal-content.mjs).
 * The matching formal, typeset PDFs in src/legal/assets/*.pdf are the canonical
 * artifacts the signer downloads and that the signed Certificate-of-Completion
 * copy is built on — the HTML and the PDF are two renderings of the SAME text.
 *
 * ⚠️ Versions are IMMUTABLE SOC-2 consent evidence: onboard_consent rows
 * reference (docType, docVersion) forever. NEVER edit a shipped version's text
 * in place — change the source, then bump LEGAL_SEED_VERSION so it seeds as a
 * NEW version (seedDraftDocs activates it and de-activates the prior one).
 *
 * Copy rule: the document is titled "Subscription Agreement" (SA) — the strings
 * "MSA" / "Master Subscription Agreement" must not appear.
 */
import {
  SUBSCRIPTION_AGREEMENT_HTML,
  TERMS_OF_SERVICE_HTML,
} from './legal-doc-content.js';

// Bumped from '2026.07-draft1' (COUNSEL-PENDING placeholder) to the
// counsel-provided text delivered 2026-07-22. The '-trial'/'-paid' SA suffixes
// are retained so each consent row still records which plan the signer was on,
// even though the unified SA text is identical across plans (trial conversion
// is handled inside the SA itself — see SA §2.6 and Exhibit A).
export const LEGAL_SEED_VERSION = '2026.07-v1';

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
    html: TERMS_OF_SERVICE_HTML,
  },
  // Both SA variants carry the identical unified agreement; the variant only
  // records the plan the signer accepted under. Re-run `task seed-legal-docs`
  // after a version change — it activates the new versions and de-activates
  // the old ones per (docType, planVariant).
  {
    docType: 'sa',
    planVariant: 'trial',
    version: `${LEGAL_SEED_VERSION}-trial`,
    html: SUBSCRIPTION_AGREEMENT_HTML,
  },
  {
    docType: 'sa',
    planVariant: 'paid',
    version: `${LEGAL_SEED_VERSION}-paid`,
    html: SUBSCRIPTION_AGREEMENT_HTML,
  },
];
