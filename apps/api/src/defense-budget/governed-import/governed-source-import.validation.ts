/**
 * Phase 10B-18 Part G — governed operator-attested import validation.
 *
 * Pure, side-effect-free pre-write checks for `import-defense-budget-source-v1`.
 * No Prisma, no S3, no filesystem access — the CLI/service layer reads the
 * expected source, the bundle member, and the local file into plain data and
 * hands it here. Every failure is fail-closed: a `GovernedImportRefusal` is
 * returned (never thrown for an expected bad-input case), and the caller's
 * contract is to attempt NO database or S3 mutation whatsoever when this
 * returns anything other than `{ ok: true }`.
 *
 * This deliberately reuses the SAME identity primitives the live watcher
 * uses for the same adapter (`SourceAdapterRegistry.assertAuthoritativeHost`,
 * `classifyLifecycleSource`) rather than inventing a parallel, potentially
 * divergent check — an operator-supplied document for this adapter must pass
 * the identical bar a live fetch would.
 */
import { createHash } from 'node:crypto';

import {
  ARMY_BUDGET_OFFICIAL_HOSTS,
  classifyLifecycleSource,
  type AuthorityTrack,
  type BudgetComponent,
  type LifecycleStage,
  type SourceFamily,
} from '@capiro/defense-domain';

export interface GovernedImportExpectedSourceFacts {
  readonly id: string;
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly stage: LifecycleStage;
  readonly sourceFamily: SourceFamily;
  readonly component: BudgetComponent;
  readonly adapterId: string;
}

export type GovernedImportMemberStatus = 'missing' | 'observed' | 'verified';

export interface GovernedImportBundleMemberFacts {
  readonly id: string;
  readonly expectedSourceId: string;
  readonly memberKey: string;
  readonly officialUrl: string;
  readonly title: string;
  readonly required: boolean;
  readonly memberStatus: GovernedImportMemberStatus;
  /** sha256 of the bytes currently bound to this member, if any. */
  readonly boundContentSha256: string | null;
}

/** Every OTHER member in the same bundle — for the cross-member same-SHA check and bundle completeness. */
export interface GovernedImportSiblingMemberFacts {
  readonly memberKey: string;
  readonly required: boolean;
  readonly memberStatus: GovernedImportMemberStatus;
  readonly boundContentSha256: string | null;
}

export interface GovernedImportRequestInput {
  readonly expectedSource: GovernedImportExpectedSourceFacts;
  readonly bundleMember: GovernedImportBundleMemberFacts;
  readonly siblingMembers: readonly GovernedImportSiblingMemberFacts[];
  readonly officialUrlArg: string;
  readonly fileBytes: Buffer;
  readonly actor: string;
  readonly reason: string;
}

export const GOVERNED_IMPORT_REFUSAL_CODES = [
  'operator_identity_required',
  'reason_required',
  'member_belongs_to_different_expected_source',
  'official_url_argument_mismatch',
  'non_official_host',
  'empty_file',
  'not_a_pdf',
  'html_or_waf_block_page',
  'wrong_fiscal_year',
  'wrong_source_family',
  'wrong_component',
  'ambiguous_document_identity',
  'member_already_bound_to_different_sha',
  'sha_already_bound_to_different_member',
] as const;
export type GovernedImportRefusalCode = (typeof GOVERNED_IMPORT_REFUSAL_CODES)[number];

export interface GovernedImportRefusal {
  readonly ok: false;
  readonly code: GovernedImportRefusalCode;
  readonly reason: string;
}

export interface GovernedImportAccepted {
  readonly ok: true;
  readonly contentSha256: string;
  readonly byteSize: number;
}

export type GovernedImportValidationResult = GovernedImportAccepted | GovernedImportRefusal;

function refuse(code: GovernedImportRefusalCode, reason: string): GovernedImportRefusal {
  return { ok: false, code, reason };
}

const PDF_MAGIC = Buffer.from('%PDF-', 'utf8');

/**
 * A real Akamai/WAF block page — and most generic HTML error pages — start
 * with `<` (`<!DOCTYPE html>` or `<html`) well before any binary PDF bytes
 * ever would. Checked before the generic "not a PDF" refusal so the operator
 * gets a specific, actionable reason instead of a generic one.
 */
function looksLikeHtml(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 512).toString('latin1').trimStart();
  return /^<(!doctype\s+html|html\b)/i.test(head) || head.includes('Access Denied');
}

export function validateGovernedImportRequest(
  input: GovernedImportRequestInput,
): GovernedImportValidationResult {
  if (input.actor.trim().length === 0) {
    return refuse('operator_identity_required', '--actor must be a non-empty operator identity');
  }
  if (input.reason.trim().length === 0) {
    return refuse('reason_required', '--reason must be a non-empty justification');
  }
  if (input.bundleMember.expectedSourceId !== input.expectedSource.id) {
    return refuse(
      'member_belongs_to_different_expected_source',
      `bundle member ${input.bundleMember.id} belongs to expected source ` +
        `${input.bundleMember.expectedSourceId}, not the requested ${input.expectedSource.id}`,
    );
  }
  if (input.officialUrlArg !== input.bundleMember.officialUrl) {
    return refuse(
      'official_url_argument_mismatch',
      `--official-url "${input.officialUrlArg}" does not equal the registered official URL for ` +
        `member ${input.bundleMember.memberKey} ("${input.bundleMember.officialUrl}")`,
    );
  }

  // Fail-closed host check, mirroring `SourceAdapterRegistry.assertAuthoritativeHost`
  // (apps/defense-api) exactly: HTTPS plus a registered official host for
  // this exact adapter. Only `army-budget` and `navy-budget` are wired for
  // governed import in this phase — any other adapter fails closed rather
  // than silently skipping the check.
  const NAVY_BUDGET_OFFICIAL_HOSTS: readonly string[] = Object.freeze([
    'secnav.navy.mil',
    'www.secnav.navy.mil',
  ]);
  const officialHostsByAdapter: Record<string, readonly string[]> = {
    'army-budget': ARMY_BUDGET_OFFICIAL_HOSTS,
    'navy-budget': NAVY_BUDGET_OFFICIAL_HOSTS,
  };
  const officialHosts = officialHostsByAdapter[input.expectedSource.adapterId];
  if (!officialHosts) {
    return refuse(
      'non_official_host',
      `governed import does not yet support adapter "${input.expectedSource.adapterId}"`,
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(input.officialUrlArg);
  } catch {
    return refuse('non_official_host', `--official-url "${input.officialUrlArg}" is not a valid URL`);
  }
  if (parsedUrl.protocol !== 'https:' || !officialHosts.includes(parsedUrl.hostname)) {
    return refuse(
      'non_official_host',
      `--official-url "${input.officialUrlArg}" is not on a registered official host for adapter ` +
        `"${input.expectedSource.adapterId}" (${officialHosts.join(', ')})`,
    );
  }

  if (input.fileBytes.byteLength === 0) {
    return refuse('empty_file', 'the supplied file is empty (0 bytes)');
  }
  if (looksLikeHtml(input.fileBytes)) {
    return refuse(
      'html_or_waf_block_page',
      'the supplied file begins with an HTML document, not a PDF — this is the shape of a WAF/bot-block page, not the official document',
    );
  }
  if (!input.fileBytes.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    return refuse(
      'not_a_pdf',
      `the supplied file does not begin with the PDF signature ("${PDF_MAGIC.toString('utf8')}")`,
    );
  }

  const classified = classifyLifecycleSource({
    url: input.officialUrlArg,
    packageId: null,
    title: input.bundleMember.title,
    declaredFiscalYear: input.expectedSource.fiscalYear,
    contentExcerpt: null,
    contentExcerptAvailable: false,
    divisionEvidence: null,
    adapterId: input.expectedSource.adapterId,
  });

  // `classified.decision` is a DISCOVERY-time confidence gate ("is this
  // confident enough to auto-accept an UNKNOWN candidate"), not an identity
  // check — for an army-budget (or any publisher-native-only) document,
  // `decision` is structurally ALWAYS 'review' regardless of correctness,
  // because `PUBLISHER_NATIVE_CONFIDENCE_CEILING` (0.7) sits below
  // `CLASSIFICATION_ACCEPT_THRESHOLD` (0.8) by design: "publisher identity
  // can route a document but can never advance a stage on its own"
  // (publisher-native-kinds.ts). Governed import is not discovering an
  // unknown document — the expected source and bundle member are ALREADY
  // known and registered — so the real check is whether the classifier could
  // resolve an identity AT ALL, then whether that resolved identity agrees
  // with what is already expected. A `classification: null` means it could
  // not resolve a stage/family/fiscal-year from this title/URL at all, which
  // IS a genuine ambiguity this must still refuse.
  if (classified.classification == null) {
    return refuse(
      'ambiguous_document_identity',
      `document identity could not be resolved from the expected member's title/URL at all: ${classified.reasons.join('; ') || 'unresolved classification'}`,
    );
  }
  if (classified.classification.fiscalYear !== input.expectedSource.fiscalYear) {
    return refuse(
      'wrong_fiscal_year',
      `document identity resolved to FY${classified.classification.fiscalYear}, expected FY${input.expectedSource.fiscalYear}`,
    );
  }
  if (classified.classification.sourceFamily !== input.expectedSource.sourceFamily) {
    return refuse(
      'wrong_source_family',
      `document identity resolved to source family "${classified.classification.sourceFamily}", expected "${input.expectedSource.sourceFamily}"`,
    );
  }
  if (
    input.expectedSource.component != null &&
    classified.classification.component !== input.expectedSource.component
  ) {
    return refuse(
      'wrong_component',
      `document identity resolved to component "${classified.classification.component}", expected "${input.expectedSource.component}"`,
    );
  }

  const contentSha256 = createHash('sha256').update(input.fileBytes).digest('hex');

  // Part K — same member, different SHA than what is already bound: fail
  // closed. No supersession workflow exists yet, so an operator who believes
  // the publisher revised the document must escalate rather than silently
  // rebind this member.
  if (
    input.bundleMember.memberStatus !== 'missing' &&
    input.bundleMember.boundContentSha256 != null &&
    input.bundleMember.boundContentSha256 !== contentSha256
  ) {
    return refuse(
      'member_already_bound_to_different_sha',
      `member ${input.bundleMember.memberKey} is already bound to sha256=${input.bundleMember.boundContentSha256}; ` +
        `the supplied bytes hash to ${contentSha256}. Refusing to rebind without an explicit supersession workflow.`,
    );
  }

  // Part K — same bytes already bound to a DIFFERENT member: never silently
  // treat this as a duplicate/no-op. Two Army R-2 budget-activity volumes
  // sharing identical bytes is not a legitimate outcome; it almost always
  // means the wrong file was supplied for this member.
  const collidingSibling = input.siblingMembers.find(
    (sibling) => sibling.memberKey !== input.bundleMember.memberKey && sibling.boundContentSha256 === contentSha256,
  );
  if (collidingSibling) {
    return refuse(
      'sha_already_bound_to_different_member',
      `sha256=${contentSha256} is already bound to member ${collidingSibling.memberKey}; refusing to also bind it ` +
        `to ${input.bundleMember.memberKey} without evaluating bundle semantics (this looks like the wrong file was supplied)`,
    );
  }

  return { ok: true, contentSha256, byteSize: input.fileBytes.byteLength };
}
