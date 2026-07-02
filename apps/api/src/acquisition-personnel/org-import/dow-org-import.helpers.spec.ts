import {
  cleanOrgName,
  isCleanOffice,
  classifyOfficeType,
  DOW_ROLE_MAP,
  normalizeDowService,
} from './dow-org-import.helpers.js';

/**
 * The samples below are REAL org strings from dow_v6_people.json (DoW Directory
 * Update 6 parse). The gate was tuned against the full 2,703-string universe
 * (scripts/__tools__/eval_dow_org_gate.ts re-runs that evaluation); these cases pin
 * the tuned behavior so future edits can't silently re-admit junk or drop real offices.
 */

describe('cleanOrgName', () => {
  test('strips trailing punctuation, markdown bleed, zero-width chars', () => {
    expect(cleanOrgName('Office of the Secretary of War?')).toBe('Office of the Secretary of War');
    expect(cleanOrgName('PAE Space-based Sensing and Targeting:')).toBe(
      'PAE Space-based Sensing and Targeting',
    );
    expect(cleanOrgName('# Office of Management & Budget')).toBe('Office of Management & Budget');
    expect(cleanOrgName('  Navy   NAVSEA​ ')).toBe('Navy NAVSEA');
  });
});

describe('isCleanOffice — accepts real offices', () => {
  const ACCEPT: Array<[string, number]> = [
    ['Office of the Secretary of War', 498],
    ['PAE Space-based Sensing and Targeting', 164],
    ['Assistant Secretary of the Air Force for Acquisition, Technology and Logistics', 22],
    ['Navy NAVSEA', 98], // no office keyword — accepted on headcount corroboration
    ['Office of Space Commerce', 84],
    ['Capability Program Executive: Ammunition and Energetics (CPE A&E)', 19],
    ['Fixed Wing Project Office (FWPO)', 1], // keyword accept, single mention
    ['J1 - Manpower and Personnel Directorate', 22],
    ['Defense Health Agency (DHA)', 18],
    ['Army Cyber Command ARCYBER', 17],
  ];
  test.each(ACCEPT)('accepts %s', (name, count) => {
    expect(isCleanOffice(cleanOrgName(name), count)).toBe(true);
  });
});

describe('isCleanOffice — rejects extraction junk', () => {
  const REJECT: Array<[string, number]> = [
    // person-name bleed (rank/honorific prefixes)
    ['COL Brad Dello - Strategy and Partnerships, Office of Strategic Capital', 140],
    ['CAPT Martin L. Edmonds -Sustainment Director, PAE Maritime', 43],
    // document artifacts
    ['Rev 6', 70],
    // bare generic headings, even with high headcount
    ['Directorate', 60],
    ['Command', 16],
    ['Office', 12],
    // prose fragments
    ['Co-Founder Steve Feinberg is the current Deputy Secretary of War', 34],
    ['Engineers reports to the Assistant Secretary of the Army for Civil Works (ASA(', 35],
    ['CPE ES2 has four portfolios or project offices', 21],
    ['Command under a new International Command', 32],
    ['Subordinate to U.S. Fleet Cyber Command (and by extension, U.S. 10th Fleet)', 53],
    ['13 Capability Program Executives (CPEs)', 1],
    ['PEO-based model', 17],
    // truncation / fragment tells
    ['Combat Command)', 20], // unbalanced parens
    ['the Chemical Materials Agency', 29], // lowercase start
    // URLs
    ['MDA - Missile Defense Agency SBIR - www.mda.mil/business/SBIR_STTR_programs.html', 1],
    // contractors belong in performer space, not the government org graph
    ['Lockheed Martin Rotary and Mission Systems', 1],
    ['Raytheon Information Systems', 1],
    ['BAE Systems Deep Tech Accelerator', 1],
    // found by the prod DRY-RUN sample (frequency-sorted eval missed them):
    ['Logistics Agency (DLA). See here.16 It can take 4 months to get certified', 1], // footnote bleed
    ['Stephen Ehikian', 5], // civilian person name, no rank prefix
    ['GSA security assessment and authorization for cloud service offerings', 2], // lowercase prose
  ];
  test.each(REJECT)('rejects %s', (name, count) => {
    expect(isCleanOffice(cleanOrgName(name), count)).toBe(false);
  });
});

describe('classifyOfficeType', () => {
  test('maps names onto the ProgramOffice.officeType vocabulary', () => {
    expect(classifyOfficeType('PAE Space-based Sensing and Targeting')).toBe('pae');
    expect(classifyOfficeType('Capability Program Executive (CPE): Combat Logistics')).toBe('cpe');
    expect(classifyOfficeType('PEO Aviation')).toBe('peo');
    expect(classifyOfficeType('PM Air Defense')).toBe('pm');
    expect(classifyOfficeType('Army Contracting Command')).toBe('contracting_office');
    expect(classifyOfficeType('Army Cyber Command ARCYBER')).toBe('command');
    expect(classifyOfficeType('J1 - Manpower and Personnel Directorate')).toBe('directorate');
    expect(classifyOfficeType('Office of Space Commerce')).toBe('other');
  });
});

describe('DOW_ROLE_MAP + normalizeDowService', () => {
  test('directory roles map onto PersonRole.roleType', () => {
    expect(DOW_ROLE_MAP.PEO).toBe('peo');
    expect(DOW_ROLE_MAP.PM).toBe('pm');
    expect(DOW_ROLE_MAP.DPM).toBe('pm');
    expect(DOW_ROLE_MAP.DEP_DIRECTOR).toBe('deputy');
    expect(DOW_ROLE_MAP.CE).toBe('chief_engineer');
    expect(DOW_ROLE_MAP.DIRECTOR).toBe('other');
  });
  test('service normalization', () => {
    expect(normalizeDowService('Army')).toBe('ARMY');
    expect(normalizeDowService('Marine Corps')).toBe('USMC');
    expect(normalizeDowService('Space Force')).toBe('SF');
    expect(normalizeDowService('Air Force')).toBe('AF');
    expect(normalizeDowService('Office of the Secretary of War')).toBe('DW');
    expect(normalizeDowService('')).toBeNull();
  });
});
