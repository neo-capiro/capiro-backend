import { classifyArtifact } from './source-document-classify.js';

describe('classifyArtifact', () => {
  it('classifies the R-1 master list (fy from filename, no component)', () => {
    const c = classifyArtifact('jbook_r1_fy2027.json')!;
    expect(c).toMatchObject({
      sourceKey: 'jbook_r1_fy2027',
      documentType: 'r1',
      budgetCycle: 'pb',
      component: null,
      fiscalYear: 2027,
      sourceTag: null,
    });
  });

  it('classifies an R-2 J-book with component from the filename token', () => {
    const c = classifyArtifact('jbook_r2_dw_darpa.json', { fy: 2027 })!;
    expect(c).toMatchObject({ documentType: 'r2', budgetCycle: 'pb', component: 'DW', fiscalYear: 2027 });
  });

  it('classifies an R-3 performers artifact as documentType r3 (distinct from r2)', () => {
    const c = classifyArtifact('jbook_performers_navy_ba4.json', { fy: 2027 })!;
    expect(c).toMatchObject({ documentType: 'r3', component: 'NAVY', fiscalYear: 2027 });
  });

  it('infers ARMY from volN tokens and NAVY from RDTEN', () => {
    expect(classifyArtifact('jbook_r2_vol3_ba5a_fy2027.json')!.component).toBe('ARMY');
    expect(classifyArtifact('jbook_r2_RDTEN_BA1-3_Book.json', { fy: 2027 })!.component).toBe('NAVY');
    expect(classifyArtifact('jbook_performers_af_vol1.json', { fy: 2027 })!.component).toBe('AF');
    expect(classifyArtifact('jbook_r2_sf_rdte_fy2027.json')!.component).toBe('SF');
  });

  it('classifies HASC/SASC committee reports with the year-source-value source tag', () => {
    const hasc = classifyArtifact('armed_services_hasc_fy2027.json', { fy: 2027 })!;
    expect(hasc).toMatchObject({ documentType: 'committee_report', budgetCycle: 'hasc', sourceTag: 'hasc_report_fy27' });

    const sasc = classifyArtifact('armed_services_sasc_fy2026.json', { fy: 2026 })!;
    expect(sasc).toMatchObject({ documentType: 'committee_report', budgetCycle: 'sasc', sourceTag: 'sasc_report_fy26' });
  });

  it('uses the artifact chamber to disambiguate a generic armed_services filename', () => {
    const c = classifyArtifact('armed_services_fy2027.json', { fy: 2027, chamber: 'SASC' })!;
    expect(c).toMatchObject({ budgetCycle: 'sasc', sourceTag: 'sasc_report_fy27' });
  });

  it('classifies defense-approps, conference and public-law artifacts', () => {
    expect(classifyArtifact('defense_approps_hac_d_fy2027.json', { fy: 2027 })!).toMatchObject({
      budgetCycle: 'hac_d',
      documentType: 'committee_report',
      sourceTag: 'hac_d_report_fy27',
    });
    expect(classifyArtifact('ndaa_conference_fy2027.json', { fy: 2027 })!).toMatchObject({
      budgetCycle: 'conference',
      documentType: 'conference_report',
      sourceTag: 'conference_report_fy27',
    });
    expect(classifyArtifact('defense_public_law_fy2027.json', { fy: 2027 })!).toMatchObject({
      budgetCycle: 'enacted',
      documentType: 'public_law',
      sourceTag: 'public_law_fy27',
    });
  });

  it('returns null for non-budget artifacts (e.g. directory dumps)', () => {
    expect(classifyArtifact('dow_directory_full.json')).toBeNull();
    expect(classifyArtifact('some_random_file.json')).toBeNull();
  });
});
