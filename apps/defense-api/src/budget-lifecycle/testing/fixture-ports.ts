/**
 * Fixture discovery/fetch ports plus the recorded FY2024 lifecycle corpus.
 *
 * Every title and excerpt below is text actually published by GovInfo for the
 * named package, transcribed from the official `.htm` rendition (or, for the
 * PDF-only President's Budget package, from the PDF's own cover). Using real
 * publisher wording matters: it is what makes the classifier tests meaningful
 * rather than a test of invented strings.
 *
 * Content SHAs here are deterministic fixture values. Byte identity is what the
 * separate real-source replay script proves against live downloads; these tests
 * are about the decisions taken around those bytes.
 */

import { createHash } from 'node:crypto';

import type {
  DiscoveredCandidate,
  FetchedSource,
  SourceDiscoveryPort,
  SourceFetchPort,
} from '../lifecycle-ports.js';

export const sha = (seed: string): string =>
  createHash('sha256').update(`phase8-session7-fixture:${seed}`).digest('hex');

export interface FixtureSource {
  readonly key: string;
  readonly adapterId: string;
  readonly url: string;
  readonly packageId: string | null;
  readonly title: string;
  /** Real transcribed publisher text, or null when the publisher offers none. */
  readonly contentExcerpt: string | null;
  readonly divisionEvidence?: string | null;
  readonly versionRank?: number | null;
  readonly shaSeed: string;
  readonly httpEtag?: string | null;
  readonly httpLastModified?: string | null;
}

const GOVINFO = 'https://www.govinfo.gov/content/pkg';
const pdf = (id: string): string => `${GOVINFO}/${id}/pdf/${id}.pdf`;

/**
 * FY2024 President's Budget, defence volume, as published by the DoD
 * Comptroller. Like every comptroller/service exhibit it is PDF-only, so there
 * is no text rendition to corroborate against.
 */
export const FY2024_PB: FixtureSource = {
  key: 'fy2024-pb',
  adapterId: 'dod-comptroller',
  url:
    'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/' +
    'FY2024_Budget_Request_Overview_Book.pdf',
  packageId: null,
  title: 'Department of Defense Fiscal Year 2024 Budget Request Overview',
  contentExcerpt: null,
  shaSeed: 'dod-fy2024-budget-request-overview',
  httpLastModified: 'Fri, 17 Mar 2023 18:22:19 GMT',
};

export const FY2024_HASC_REPORT: FixtureSource = {
  key: 'fy2024-hasc-report',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-118hrpt125'),
  packageId: 'CRPT-118hrpt125',
  title: 'House Report 118-125 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
  contentExcerpt:
    'House Report 118-125 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024 ' +
    '[House Report 118-125] [From the U.S. Government Publishing Office] 118th Congress ' +
    'HOUSE OF REPRESENTATIVES Report 118-125 NATIONAL DEFENSE AUTHORIZATION ACT FOR ' +
    'FISCAL YEAR 2024 REPORT of the COMMITTEE ON ARMED SERVICES',
  shaSeed: 'crpt-118hrpt125',
  httpLastModified: 'Fri, 08 Nov 2024 16:28:24 GMT',
};

export const FY2024_SASC_REPORT: FixtureSource = {
  key: 'fy2024-sasc-report',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-118srpt58'),
  packageId: 'CRPT-118srpt58',
  title: 'Senate Report 118-58 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024',
  contentExcerpt:
    'Senate Report 118-58 - NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024 ' +
    '[Senate Report 118-58] [From the U.S. Government Publishing Office] 118th Congress ' +
    'SENATE Report 118-58 NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024 ' +
    'REPORT of the COMMITTEE ON ARMED SERVICES',
  shaSeed: 'crpt-118srpt58',
  httpLastModified: 'Fri, 08 Nov 2024 14:31:01 GMT',
};

/** House-passed NDAA. `rh` = reported in House; `eh` = engrossed (passed). */
export const FY2024_HOUSE_NDAA_REPORTED: FixtureSource = {
  key: 'fy2024-house-ndaa-rh',
  adapterId: 'govinfo-bills',
  url: pdf('BILLS-118hr2670rh'),
  packageId: 'BILLS-118hr2670rh',
  title: 'H.R. 2670 (RH) - National Defense Authorization Act for Fiscal Year 2024',
  contentExcerpt:
    '[Congressional Bills 118th Congress] [From the U.S. Government Publishing Office] ' +
    '[H.R. 2670 Reported in House (RH)] Union Calendar No. 97 118th CONGRESS 1st Session ' +
    'H. R. 2670 [Report No. 118-125] To authorize appropriations for fiscal year 2024 for ' +
    'military activities of the Department of Defense and for military construction ... ' +
    'SECTION 1. SHORT TITLE. This Act may be cited as the "National Defense Authorization ' +
    'Act for Fiscal Year 2024".',
  versionRank: 2,
  shaSeed: 'bills-118hr2670rh',
};

export const FY2024_HOUSE_NDAA_PASSED: FixtureSource = {
  key: 'fy2024-house-ndaa-eh',
  adapterId: 'govinfo-bills',
  url: pdf('BILLS-118hr2670eh'),
  packageId: 'BILLS-118hr2670eh',
  title: 'H.R. 2670 (EH) - National Defense Authorization Act for Fiscal Year 2024',
  contentExcerpt:
    '[Congressional Bills 118th Congress] [From the U.S. Government Publishing Office] ' +
    '[H.R. 2670 Engrossed in House (EH)] 118th CONGRESS 1st Session H. R. 2670 AN ACT To ' +
    'authorize appropriations for fiscal year 2024 for military activities of the ' +
    'Department of Defense ... SECTION 1. SHORT TITLE. This Act may be cited as the ' +
    '"National Defense Authorization Act for Fiscal Year 2024".',
  versionRank: 3,
  shaSeed: 'bills-118hr2670eh',
};

export const FY2024_NDAA_ENACTED: FixtureSource = {
  key: 'fy2024-ndaa-enacted',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-118publ31'),
  packageId: 'PLAW-118publ31',
  title: 'Public Law 118-31 - National Defense Authorization Act for Fiscal Year 2024',
  contentExcerpt:
    '[118th Congress Public Law 31] [From the U.S. Government Publishing Office] ' +
    'NATIONAL DEFENSE AUTHORIZATION ACT FOR FISCAL YEAR 2024 Public Law 118-31 118th ' +
    'Congress An Act To authorize appropriations for fiscal year 2024 for military ' +
    'activities of the Department of Defense',
  shaSeed: 'plaw-118publ31',
};

/**
 * HAC-D report. Its front matter states NO "fiscal year" phrase at all — only
 * "DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024".
 */
export const FY2024_HACD_REPORT: FixtureSource = {
  key: 'fy2024-hacd-report',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-118hrpt121'),
  packageId: 'CRPT-118hrpt121',
  title: 'House Report 118-121 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
  contentExcerpt:
    'House Report 118-121 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024 [House Report ' +
    '118-121] [From the U.S. Government Publishing Office] 118th Congress 1st Session ' +
    'HOUSE OF REPRESENTATIVES Report 118-121 DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, ' +
    '2024 REPORT of the COMMITTEE ON APPROPRIATIONS together with MINORITY VIEWS [to ' +
    'accompany h.r. 4365] June 27, 2023.',
  shaSeed: 'crpt-118hrpt121',
};

export const FY2024_SACD_REPORT: FixtureSource = {
  key: 'fy2024-sacd-report',
  adapterId: 'govinfo-committee-reports',
  url: pdf('CRPT-118srpt81'),
  packageId: 'CRPT-118srpt81',
  title: 'Senate Report 118-81 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024',
  contentExcerpt:
    'Senate Report 118-81 - DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024 [Senate Report ' +
    '118-81] [From the U.S. Government Publishing Office] Calendar No. 181 118th Congress ' +
    '1st Session SENATE Report 118-81 DEPARTMENT OF DEFENSE APPROPRIATIONS BILL, 2024 ' +
    'July 27, 2023.--Ordered to be printed Mr. Tester, from the Committee on ' +
    'Appropriations, submitted the following REPORT [To accompany S. 2587] The Committee ' +
    'on Appropriations reports an original bill (S. 2587) making appropriations for the ' +
    'Department of Defense for the fiscal year ending September 30, 2024, and for other ' +
    'purposes.',
  shaSeed: 'crpt-118srpt81',
};

/**
 * FY2024 defence appropriations were enacted inside an omnibus vehicle. Without
 * division evidence this must NOT be attributed to the defence appropriations
 * track — the same public law also carries Labor-HHS, State-Foreign Ops and
 * others. The division line below is real text from the law itself.
 */
export const FY2024_APPROPRIATIONS_ENACTED: FixtureSource = {
  key: 'fy2024-approps-enacted',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-118publ47'),
  packageId: 'PLAW-118publ47',
  title: 'Public Law 118-47 - Further Consolidated Appropriations Act, 2024',
  contentExcerpt:
    '[118th Congress Public Law 47] [From the U.S. Government Publishing Office] FURTHER ' +
    'CONSOLIDATED APPROPRIATIONS ACT, 2024 Public Law 118-47 118th Congress An Act Making ' +
    'further consolidated appropriations for the fiscal year ending September 30, 2024, ' +
    'and for other purposes. ... DIVISION A--DEPARTMENT OF DEFENSE APPROPRIATIONS ACT, 2024',
  divisionEvidence: 'DIVISION A--DEPARTMENT OF DEFENSE APPROPRIATIONS ACT, 2024',
  shaSeed: 'plaw-118publ47',
};

/** The same omnibus with the division evidence withheld — must stop in review. */
export const FY2024_APPROPRIATIONS_ENACTED_NO_DIVISION: FixtureSource = {
  ...FY2024_APPROPRIATIONS_ENACTED,
  key: 'fy2024-approps-enacted-no-division',
  contentExcerpt:
    '[118th Congress Public Law 47] [From the U.S. Government Publishing Office] FURTHER ' +
    'CONSOLIDATED APPROPRIATIONS ACT, 2024 Public Law 118-47 118th Congress An Act Making ' +
    'further consolidated appropriations for the fiscal year ending September 30, 2024, ' +
    'and for other purposes.',
  divisionEvidence: null,
};

/** Real alternative-funding source, reused from the accepted Session 6 corpus. */
export const FY2024_UKRAINE_SUPPLEMENTAL: FixtureSource = {
  key: 'fy2024-ukraine-supplemental',
  adapterId: 'govinfo-public-laws',
  url: pdf('PLAW-118publ50'),
  packageId: 'PLAW-118publ50',
  title:
    'Public Law 118-50 - Ukraine Security Supplemental Appropriations Act, 2024 ' +
    '(fiscal year 2024)',
  contentExcerpt:
    '[118th Congress Public Law 50] MAKING EMERGENCY SUPPLEMENTAL APPROPRIATIONS FOR ' +
    'THE FISCAL YEAR ENDING SEPTEMBER 30, 2024, AND FOR OTHER PURPOSES. Public Law ' +
    '118-50 DIVISION B--UKRAINE SECURITY SUPPLEMENTAL APPROPRIATIONS ACT, 2024 ... ' +
    'emergency supplemental appropriations for fiscal year 2024',
  shaSeed: 'plaw-118publ50-div-b',
};

// ── Ports ────────────────────────────────────────────────────────────────────

export interface FixtureCandidate {
  readonly source: FixtureSource;
  readonly expectedSourceDedupKey: string;
  /** Override the fixture's SHA seed to simulate a byte change. */
  readonly shaSeedOverride?: string;
  /** Override the URL to simulate a relocation. */
  readonly urlOverride?: string;
  readonly withdrawn?: boolean;
  readonly notModified?: boolean;
  readonly blockedReason?: string;
}

export class FixtureDiscoveryPort implements SourceDiscoveryPort {
  constructor(private candidates: readonly FixtureCandidate[] = []) {}

  load(candidates: readonly FixtureCandidate[]): void {
    this.candidates = candidates;
  }

  async discover(input: { adapterId: string; cursor: Record<string, unknown> }): Promise<{
    candidates: readonly DiscoveredCandidate[];
    cursor: Record<string, unknown>;
  }> {
    const matched = this.candidates.filter(
      (candidate) => candidate.source.adapterId === input.adapterId,
    );
    return {
      candidates: matched.map((candidate) => ({
        adapterId: candidate.source.adapterId,
        expectedSourceDedupKey: candidate.expectedSourceDedupKey,
        url: candidate.urlOverride ?? candidate.source.url,
        packageId: candidate.source.packageId,
        title: candidate.source.title,
        declaredFiscalYear: null,
        divisionEvidence: candidate.source.divisionEvidence ?? null,
        versionRank: candidate.source.versionRank ?? null,
        ...(candidate.withdrawn === undefined ? {} : { withdrawn: candidate.withdrawn }),
      })),
      cursor: { ...input.cursor, fixtures: matched.length },
    };
  }
}

export class FixtureFetchPort implements SourceFetchPort {
  readonly requests: { url: string; conditionalHeaders: Record<string, string> }[] = [];

  constructor(private candidates: readonly FixtureCandidate[] = []) {}

  load(candidates: readonly FixtureCandidate[]): void {
    this.candidates = candidates;
  }

  async fetch(input: {
    url: string;
    conditionalHeaders: Readonly<Record<string, string>>;
  }): Promise<FetchedSource> {
    this.requests.push({ url: input.url, conditionalHeaders: { ...input.conditionalHeaders } });
    const candidate = this.candidates.find(
      (entry) => (entry.urlOverride ?? entry.source.url) === input.url,
    );
    if (!candidate) {
      return {
        notModified: false,
        contentSha256: null,
        byteSize: null,
        httpEtag: null,
        httpLastModified: null,
        contentExcerpt: null,
        contentExcerptAvailable: false,
        blocked: true,
        blockedReason: `no fixture for ${input.url}`,
      };
    }
    if (candidate.blockedReason) {
      return {
        notModified: false,
        contentSha256: null,
        byteSize: null,
        httpEtag: null,
        httpLastModified: null,
        contentExcerpt: null,
        contentExcerptAvailable: false,
        blocked: true,
        blockedReason: candidate.blockedReason,
      };
    }
    if (candidate.notModified) {
      return {
        notModified: true,
        contentSha256: null,
        byteSize: null,
        httpEtag: candidate.source.httpEtag ?? null,
        httpLastModified: candidate.source.httpLastModified ?? null,
        contentExcerpt: null,
        contentExcerptAvailable: false,
      };
    }
    const excerpt = candidate.source.contentExcerpt;
    return {
      notModified: false,
      contentSha256: sha(candidate.shaSeedOverride ?? candidate.source.shaSeed),
      byteSize: 1_024,
      httpEtag: candidate.source.httpEtag ?? null,
      httpLastModified: candidate.source.httpLastModified ?? null,
      contentExcerpt: excerpt,
      // Mirrors reality: GovInfo BUDGET packages have no text rendition, so the
      // President's Budget fixture declares corroboration unavailable.
      contentExcerptAvailable: excerpt !== null,
    };
  }
}
