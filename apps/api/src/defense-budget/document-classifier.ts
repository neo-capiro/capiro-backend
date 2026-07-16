/**
 * Local-corpus document classifier — maps a DoD budget PDF filename to the routing
 * metadata the ingestion pipeline needs (family, exhibit, authority, component, FY,
 * budget cycle, stable sourceKey).
 *
 * Filename conventions are messy and human-authored, so classification is heuristic and
 * CONSERVATIVE: an unclassifiable file returns family 'unknown' and is skipped by the CLI
 * (surfaced, never silently mis-ingested). This is detection metadata only — the true
 * identity of every extracted line is still decided by the exhibit it is parsed from.
 */

export interface DocClassification {
  sourceKey: string;
  family: 'rdte' | 'procurement' | 'om' | 'milpers' | 'committee' | 'bill' | 'public_law' | 'overview' | 'unknown';
  /** Best-guess primary exhibit for the extractor router. */
  exhibit: 'R-2' | 'P-40' | 'OP-5' | 'committee_report' | 'conference_report' | 'public_law' | null;
  authority: 'dod-comptroller' | 'hasc' | 'sasc' | 'hac_d' | 'sac_d' | 'ndaa_conference' | 'public_law' | 'unknown';
  component: 'ARMY' | 'NAVY' | 'AF' | 'SF' | 'DW' | 'USMC' | null;
  fiscalYear: number | null;
  budgetCycle: string;
  documentType: string;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function detectFy(name: string): number | null {
  const m = /\bfy\s?'?(\d{2})\b/i.exec(name) || /\b20(2\d)\b/.exec(name);
  if (!m) return null;
  const two = m[1]!.length === 2 ? m[1]! : m[1]!;
  const n = Number(two.length === 2 ? two : two);
  return n < 100 ? 2000 + n : n;
}

function detectComponent(n: string): DocClassification['component'] {
  const s = n.toLowerCase();
  if (/\bair\s*force|^af[_\s]|\baf_|usaf/.test(s)) return 'AF';
  if (/space\s*force|^sf[_\s]|\bsf_|spaceforce/.test(s)) return 'SF';
  if (/\bnavy|marine|usmc|\bapn\b|\bscn\b|\bwpn\b|\bpmc\b|\bpanmc\b|\bopn\b/.test(s)) return 'NAVY';
  if (/\barmy|\bapa\b|aircraft_procurement_army|missile_procurement_army/.test(s)) return 'ARMY';
  return null;
}

export function classifyDocument(filename: string): DocClassification {
  const base = filename.replace(/\\/g, '/').split('/').pop() ?? filename;
  const s = base.toLowerCase();
  const sourceKey = slugify(base);
  const fiscalYear = detectFy(base);
  const component = detectComponent(base);

  const mk = (
    family: DocClassification['family'],
    exhibit: DocClassification['exhibit'],
    authority: DocClassification['authority'],
    budgetCycle: string,
    documentType: string,
  ): DocClassification => ({ sourceKey, family, exhibit, authority, component, fiscalYear, budgetCycle, documentType });

  // GovInfo BILLS-<congress><chamber><num> packages are legislation, NOT committee
  // reports. Detect them BEFORE the committee/NDAA branches (whose title text can
  // include the word "Bill", e.g. "DoD Appropriations Bill, 2026"). The "bills-<digit>"
  // package shape is specific and won't match a committee report's prose title.
  if (/bills-\d/.test(s)) return mk('bill', null, 'unknown', 'introduced', 'bill');

  // Committee / conference / public law first (authority-defining).
  if (/crpt-\d+hrpt|hasc|house.*report|hrpt/.test(s)) return mk('committee', 'committee_report', 'hasc', 'hasc', 'committee_report');
  if (/crpt-\d+srpt|sasc|senate.*report|srpt/.test(s)) return mk('committee', 'committee_report', 'sasc', 'sasc', 'committee_report');
  if (/ndaa.*conf|conference|_jes|def_jes/.test(s)) return mk('committee', 'conference_report', 'ndaa_conference', 'conference', 'conference_report');
  if (/plaw|public.*law|publ\d+/.test(s)) return mk('public_law', 'public_law', 'public_law', 'enacted', 'public_law');
  if (/ndaa|chairmans_mark|s2296|ndaa-fy/.test(s)) return mk('committee', 'committee_report', component === 'NAVY' ? 'sasc' : 'hasc', 'hasc', 'committee_report');

  // J-book families (comptroller PB).
  if (/rdte|research.*development|r-?\d|rdten/.test(s)) return mk('rdte', 'R-2', 'dod-comptroller', 'pb', 'r2');
  if (/procurement|_proc|apn_|opn_|pmc_|wpn_|scn_|(?:^|[^a-z])apa(?:[^a-z]|$)|missile_proc|aircraft_proc|other_proc|weapons|ammunition|panmc/.test(s))
    return mk('procurement', 'P-40', 'dod-comptroller', 'pb', 'p40');
  if (/operation.*maintenance|_om_|o&m|maintenance/.test(s)) return mk('om', 'OP-5', 'dod-comptroller', 'pb', 'op5');
  if (/personnel|milpers|military_personnel/.test(s)) return mk('milpers', null, 'dod-comptroller', 'pb', 'other');
  // Non-budget artifacts (org charts, leadership/CPE pages, overviews). Runs AFTER the
  // J-book families so a real procurement/O&M book whose title happens to contain
  // "portfolio"/"management" is still ingested; a pure leadership page (e.g. "Capability
  // Program Executive ... CPE ISW") has no J-book token and correctly lands here.
  if (/overview|highlights|budget_overview|es2|portfolio|org.*chart|command_brief|leadership|leaders/.test(s))
    return mk('overview', null, 'unknown', 'pb', 'other');

  return mk('unknown', null, 'unknown', 'pb', 'other');
}
