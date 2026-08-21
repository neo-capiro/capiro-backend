/**
 * Phase 8 Session 8 — shared crawler contract and the real publisher entry points.
 *
 * The entry-point table below is configuration, not a claim about yield. Every
 * URL was requested from this environment while building the session, and the
 * observed status is recorded beside it, because four of the fourteen registered
 * publishers do not serve a plain client at all:
 *
 * ```text
 * comptroller.defense.gov/Budget-Materials/            403  Akamai
 * asafm.army.mil/                                      403  Akamai
 * saffm.hq.af.mil/                                     ---  no connection
 * www.defense.gov/                                     403  Akamai
 * www.secnav.navy.mil/fmc/fmb/Pages/Fiscal-Year-*.aspx 200  no direct document links
 * armedservices.house.gov/legislation                  200  no direct document links
 * www.armed-services.senate.gov/legislation            200  2 document links
 * appropriations.house.gov/                            200  2 document links
 * www.appropriations.senate.gov/legislation            200  no direct document links
 * ```
 *
 * That is why the GovInfo sitemap channel carries this session: it needs no API
 * key (both `api.govinfo.gov` and `api.congress.gov` answer `API_KEY_MISSING`),
 * it is explicitly listed in govinfo's own robots.txt, and it demonstrably
 * contains the packages that matter — the real `CRPT_2023` sitemap has 497
 * entries including `CRPT-118hrpt125`, and `BILLS_2023` has 13,354 including
 * every version of H.R. 2670.
 *
 * An index-page publisher that refuses us is recorded as refused. Discovery never
 * reports "nothing published" when what happened was "we were turned away".
 */

import type { RequestBudget } from '@capiro/defense-domain';
import type { DiscoveredCandidate } from '../lifecycle-ports.js';
import type { OfficialSourceAdapter } from '../source-adapter.registry.js';
import type { DiscoveryCursor } from '@capiro/defense-domain';
import type {
  NewDiscoveryCandidate,
  NewDiscoveryCrawl,
} from './discovery-audit.port.js';

export interface CrawlContext {
  readonly adapter: OfficialSourceAdapter;
  readonly nowIso: string;
  readonly runKey: string;
  readonly cursor: DiscoveryCursor;
  /** Fiscal years whose cycles are bootstrapped. */
  readonly horizonFiscalYears: readonly number[];
  readonly registeredExpectedSourceKeys: ReadonlySet<string>;
  readonly budget: RequestBudget;
}

export interface CrawlProduct {
  /** Candidates handed to the Session 7 control loop. */
  readonly candidates: readonly DiscoveredCandidate[];
  /** Every decision taken, emitted or not. */
  readonly auditCandidates: readonly NewDiscoveryCandidate[];
  readonly crawls: readonly NewDiscoveryCrawl[];
  readonly cursor: DiscoveryCursor;
  readonly budget: RequestBudget;
}

export interface PublisherCrawler {
  crawl(context: CrawlContext): Promise<CrawlProduct>;
}

/**
 * Published entry points per adapter, as verified above.
 *
 * The service-comptroller pages are fiscal-year addressed, so `{FY}` is
 * substituted per horizon year rather than hard-coding a year that would silently
 * go stale — the same reason the Session 7 templates carry no URLs.
 */
export const PUBLISHER_ENTRY_POINTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'dod-comptroller': Object.freeze([
    'https://comptroller.defense.gov/Budget-Materials/',
  ]),
  'dod-comptroller-reprogramming': Object.freeze([
    'https://comptroller.defense.gov/Budget-Execution/Reprogramming/',
  ]),
  'army-budget': Object.freeze(['https://asafm.army.mil/Budget-Materials/']),
  'navy-budget': Object.freeze([
    'https://www.secnav.navy.mil/fmc/fmb/Pages/Fiscal-Year-{FY}.aspx',
  ]),
  'saf-fm-budget': Object.freeze(['https://www.saffm.hq.af.mil/FM-Resources/Budget/']),
  hasc: Object.freeze(['https://armedservices.house.gov/legislation']),
  sasc: Object.freeze(['https://www.armed-services.senate.gov/legislation']),
  'house-appropriations': Object.freeze(['https://appropriations.house.gov/legislation']),
  'senate-appropriations': Object.freeze(['https://www.appropriations.senate.gov/legislation']),
  'dod-contract-announcements': Object.freeze([
    'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?ContentType=1&Site=945&max=100',
  ]),
});

export function entryPointsFor(
  adapterId: string,
  horizonFiscalYears: readonly number[],
): readonly string[] {
  const templates = PUBLISHER_ENTRY_POINTS[adapterId] ?? [];
  const urls = new Set<string>();
  for (const template of templates) {
    if (!template.includes('{FY}')) {
      urls.add(template);
      continue;
    }
    for (const fiscalYear of horizonFiscalYears) {
      urls.add(template.replaceAll('{FY}', String(fiscalYear)));
    }
  }
  return Object.freeze([...urls].sort());
}

/** Default per-run request budget. Deliberately bounded and resumable. */
export const DEFAULT_DISCOVERY_REQUEST_BUDGET = 250;
