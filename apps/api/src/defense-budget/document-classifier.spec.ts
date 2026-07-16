import { classifyDocument } from './document-classifier.js';

describe('classifyDocument (real corpus filenames)', () => {
  it('routes Army RDT&E volumes to rdte / R-2 / comptroller', () => {
    const c = classifyDocument('RDTE - Vol 1 - Budget Activity 1.pdf');
    expect(c.family).toBe('rdte');
    expect(c.exhibit).toBe('R-2');
    expect(c.authority).toBe('dod-comptroller');
  });

  it('routes AF RDT&E and detects the AF component', () => {
    const c = classifyDocument('AF_RDTE_Vol1.pdf');
    expect(c.family).toBe('rdte');
    expect(c.component).toBe('AF');
  });

  it('routes procurement books (APN/OPN/PMC/WPN/SCN) to procurement / P-40', () => {
    for (const f of ['APN_BA1-4_Book.pdf', 'OPN_BA1_Book.pdf', 'PMC_Book.pdf', 'WPN_Book.pdf', 'SCN_Book.pdf', 'Missile Procurement Army.pdf']) {
      expect(classifyDocument(f).family).toBe('procurement');
    }
  });

  it('routes O&M books to om / OP-5', () => {
    const c = classifyDocument('AF_OM_Vol1.pdf');
    expect(c.family).toBe('om');
    expect(c.exhibit).toBe('OP-5');
  });

  it('routes HASC/SASC committee reports by chamber', () => {
    expect(classifyDocument('CRPT-119hrpt162.pdf').authority).toBe('hasc');
    expect(classifyDocument('CRPT-119srpt127.pdf').authority).toBe('sasc');
    expect(classifyDocument('SASC-119-NDAA-FY2026.pdf').family).toBe('committee');
  });

  it('routes public law and conference/JES', () => {
    expect(classifyDocument('PLAW-119publ75.pdf').family).toBe('public_law');
    expect(classifyDocument('fy26_def_jes.pdf').exhibit).toBe('conference_report');
  });

  it('classifies non-budget artifacts as overview/unknown (skipped by CLI)', () => {
    expect(['overview', 'unknown']).toContain(classifyDocument('CPE org chart.pdf').family);
    expect(['overview', 'unknown']).toContain(classifyDocument('FY26 Presidents Budget Highlights.pdf').family);
  });

  it('produces a stable slug sourceKey', () => {
    expect(classifyDocument('RDTE - Vol 1 - Budget Activity 1.pdf').sourceKey).toBe('rdte_vol_1_budget_activity_1');
  });

  it('does not misroute a CPE leadership page to procurement (the "capability"->apa false match)', () => {
    const c = classifyDocument(
      'Leadership - Capability Program Executive - Intelligence and Spectrum Warfare - CPE ISW.pdf',
    );
    expect(c.family).not.toBe('procurement');
    expect(['overview', 'unknown']).toContain(c.family);
  });

  it('still routes a genuine Aircraft Procurement Army (APA) book to procurement', () => {
    expect(classifyDocument('APA_Book.pdf').family).toBe('procurement');
    expect(classifyDocument('Aircraft Procurement Army.pdf').family).toBe('procurement');
  });

  it('classifies a GovInfo BILLS package as a bill, not a committee report', () => {
    const c = classifyDocument('BILLS-119s2296rs.pdf');
    expect(c.family).toBe('bill');
    expect(c.family).not.toBe('committee');
  });

  it('does not misroute a committee report whose title contains the word "Bill"', () => {
    const c = classifyDocument('CRPT-119srpt52 Department of Defense Appropriations Bill 2026.pdf');
    expect(c.family).toBe('committee');
    expect(c.authority).toBe('sasc');
  });

  it('still ingests a real procurement book whose title contains "portfolio"/"management"', () => {
    const c = classifyDocument(
      'Other Procurement - BA 3, 4 & 6 - Other Support Equipment, Initial Spares and Agile Portfolio Management.pdf',
    );
    expect(c.family).toBe('procurement');
  });
});
