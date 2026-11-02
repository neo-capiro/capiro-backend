import { createHash } from 'node:crypto';
import { parseUnifiedAgenda } from './unified-agenda';

const meta = { edition: '202510' };
const action = (name: string, date: string, extra = '') =>
  `<TIMETABLE><TTBL_ACTION>${name}</TTBL_ACTION><TTBL_DATE>${date}</TTBL_DATE>${extra}</TIMETABLE>`;
const row = (timetable: string, extra = '', rin = '1234-AA01') =>
  `<RIN_INFO><RIN>${rin}</RIN><RULE_TITLE>Synthetic &amp; cited window</RULE_TITLE><PUBLICATION><PUBLICATION_ID>202510</PUBLICATION_ID></PUBLICATION>${extra.includes('<RULE_STAGE>') ? '' : '<RULE_STAGE>Proposed Rule Stage</RULE_STAGE>'}${extra}<TIMETABLE_LIST>${timetable}</TIMETABLE_LIST></RIN_INFO>`;
const xml = (rows: string) =>
  `<REGINFO_RIN_DATA RUN_DATE="2026-07-03-04:00">${rows}</REGINFO_RIN_DATA>`;

describe('Unified Agenda publisher adapter', () => {
  it('preserves publisher month without a day or confidence probability', () => {
    const input = xml(row(action('NPRM', '11/00/2026')));
    const out = parseUnifiedAgenda(input, meta);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0]).toEqual({
      sourceKey: '1234-AA01:proposed_rule',
      rin: '1234-AA01',
      title: 'Synthetic & cited window',
      eventType: 'proposed_rule',
      period: { precision: 'month', raw: '11/00/2026', year: 2026, month: 11 },
      status: 'published',
      confidence: 'not_supplied',
      source: {
        edition: '202510',
        issuedAt: null,
        url: 'https://www.reginfo.gov/public/do/eAgendaViewRule?pubId=202510&RIN=1234-AA01',
        sha256: createHash('sha256').update(input).digest('hex'),
      },
    });
    expect(out.sourceRunDate).toBe('2026-07-03-04:00');
  });
  it('admits a single projected Final Rule', () => {
    expect(
      parseUnifiedAgenda(xml(row(action('Final Rule', '01/00/2027'))), meta).candidates[0]
        ?.eventType,
    ).toBe('final_rule');
  });
  it('does not presume Final Action means final-rule publication', () => {
    const out = parseUnifiedAgenda(xml(row(action('Final Action', '01/00/2027'))), meta);
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('unsupported_final_rule_action');
  });
  it.each(['To Be Determined', '00/00/0000'])('keeps %s explicitly unplaced', (date) => {
    expect(parseUnifiedAgenda(xml(row(action('NPRM', date))), meta).candidates[0]?.period).toEqual({
      precision: 'unknown',
      raw: date,
    });
  });
  it.each(['06/14/2026', '02/29/2024'])(
    'never promotes an exact timetable date %s to forecast',
    (date) => {
      const out = parseUnifiedAgenda(xml(row(action('NPRM', date))), meta);
      expect(out.candidates).toEqual([]);
      expect(out.completedMilestones[0]).toMatchObject({
        sourceKey: '1234-AA01:proposed_rule',
        rin: '1234-AA01',
        action: 'NPRM',
        rawDate: date,
      });
    },
  );
  it('holds an exact future date without manufacturing source completion', () => {
    const out = parseUnifiedAgenda(xml(row(action('NPRM', '11/14/2026'))), meta);
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('future_proposed_rule_completion');
  });
  it.each(['', '2026-02-30-04:00', '2026-07-03+14:30', 'not-a-date'])(
    'does not complete without valid source run-date evidence %s',
    (runDate) => {
      const input = xml(row(action('NPRM', '03/14/2026'))).replace('2026-07-03-04:00', runDate);
      const out = parseUnifiedAgenda(input, meta);
      expect(out.completedMilestones).toEqual([]);
      expect(out.rejected[0]?.reason).toBe('unverified_proposed_rule_completion_clock');
    },
  );
  it('preserves projected months when the publisher run date is missing', () => {
    const input = xml(row(action('NPRM', '11/00/2026'))).replace(
      ' RUN_DATE="2026-07-03-04:00"',
      '',
    );
    const out = parseUnifiedAgenda(input, meta);
    expect(out.candidates).toHaveLength(1);
    expect(out.completedMilestones).toEqual([]);
  });
  it('reports a source-completed final-rule milestone without creating a forecast', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('Final Rule', '03/14/2026'), '<RULE_STAGE>Completed Actions</RULE_STAGE>')),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones[0]).toMatchObject({
      sourceKey: '1234-AA01:final_rule',
      action: 'Final Rule',
      rawDate: '03/14/2026',
    });
  });
  it('does not complete a generic Final Action', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('Final Action', '03/14/2026'), '<RULE_STAGE>Completed Actions</RULE_STAGE>')),
      meta,
    );
    expect(out.completedMilestones).toEqual([]);
  });
  it('does not publish future projections from a completed record', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('Final Rule', '03/00/2026'), '<RULE_STAGE>Completed Actions</RULE_STAGE>')),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toEqual([]);
  });
  it.each([
    '13/00/2026',
    '02/30/2026',
    'Q1 FY2027',
    '2026-11',
    '00/00/2026',
    '01/00/9999',
    '12/00/9999',
    '01/00/10000',
  ])('rejects unsupported precision %s', (date) => {
    const out = parseUnifiedAgenda(xml(row(action('NPRM', date))), meta);
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('invalid_proposed_rule_projection');
  });
  it('admits the highest supported civil month without requiring a five-digit range end', () => {
    expect(
      parseUnifiedAgenda(xml(row(action('NPRM', '12/00/9998'))), meta).candidates[0]?.period,
    ).toEqual({ precision: 'month', raw: '12/00/9998', year: 9998, month: 12 });
  });
  it('preserves source identity when the single milestone month changes', () => {
    const a = parseUnifiedAgenda(xml(row(action('NPRM', '11/00/2026'))), meta);
    const b = parseUnifiedAgenda(xml(row(action('NPRM', '12/00/2026'))), meta);
    expect(a.candidates[0]?.sourceKey).toBe(b.candidates[0]?.sourceKey);
    expect(a.candidates[0]?.source.sha256).not.toBe(b.candidates[0]?.source.sha256);
  });
  it('accepts publisher HTML doctype inside literal CDATA without reading its markup', () => {
    const out = parseUnifiedAgenda(
      xml(
        row(
          action('NPRM', '11/00/2026'),
          '<ABSTRACT><![CDATA[<!DOCTYPE html><p>Publisher abstract</p>]]></ABSTRACT>',
        ),
      ),
      meta,
    );
    expect(out.candidates).toHaveLength(1);
  });
  it.each(['NPRM', 'Second NPRM', 'FNPRM'])('holds repeated milestones including %s', (name) => {
    const out = parseUnifiedAgenda(
      xml(row(action('NPRM', '11/00/2026') + action(name, '12/00/2026'))),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('ambiguous_proposed_rule_milestone');
  });
  it('does not confuse deadline rows with repeated publications', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('NPRM', '11/00/2026') + action('NPRM Comment Period End', '12/00/2026'))),
      meta,
    );
    expect(out.candidates).toHaveLength(1);
  });
  it('refuses old completed and new projected milestone reuse', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('NPRM', '10/15/2025') + action('NPRM', '11/00/2026'))),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('ambiguous_proposed_rule_milestone');
  });
  it('requires explicit completed withdrawal evidence', () => {
    const out = parseUnifiedAgenda(
      xml(
        row(
          action('NPRM', '10/15/2024') + action('Withdrawn', '09/29/2025'),
          '<RULE_STAGE>Completed Actions</RULE_STAGE>',
        ),
      ),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.withdrawnRins[0]).toMatchObject({
      rin: '1234-AA01',
      action: 'Withdrawn',
      rawDate: '09/29/2025',
      source: { edition: '202510', issuedAt: null },
    });
  });
  it('preserves an explicitly completed NPRM before the same rulemaking is withdrawn', () => {
    const input = xml(
      row(
        action('NPRM', '08/20/2025', '<FR_CITATION>90 FR 12345</FR_CITATION>') +
          action('Withdrawn', '09/01/2025'),
        '<RULE_STAGE>Completed Actions</RULE_STAGE>',
      ),
    );
    const out = parseUnifiedAgenda(input, meta);
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toHaveLength(1);
    expect(out.completedMilestones[0]).toMatchObject({
      sourceKey: '1234-AA01:proposed_rule',
      action: 'NPRM',
      rawDate: '08/20/2025',
    });
    expect(out.withdrawnRins).toHaveLength(1);
    expect(out.withdrawnRins[0]).toMatchObject({
      rin: '1234-AA01',
      action: 'Withdrawn',
      rawDate: '09/01/2025',
    });
    expect(out.completedMilestones[0]?.source).toEqual(out.withdrawnRins[0]?.source);
  });
  it('still holds ambiguous repeated completed milestones in a withdrawn rulemaking', () => {
    const out = parseUnifiedAgenda(
      xml(
        row(
          action('NPRM', '08/01/2025') +
            action('NPRM', '08/20/2025') +
            action('Withdrawn', '09/01/2025'),
          '<RULE_STAGE>Completed Actions</RULE_STAGE>',
        ),
      ),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toEqual([]);
    expect(out.withdrawnRins).toHaveLength(1);
    expect(out.rejected[0]?.reason).toBe('ambiguous_proposed_rule_milestone');
  });
  it('never publishes a projected window from a withdrawn rulemaking', () => {
    const out = parseUnifiedAgenda(
      xml(
        row(
          action('NPRM', '08/00/2025') + action('Withdrawn', '09/01/2025'),
          '<RULE_STAGE>Completed Actions</RULE_STAGE>',
        ),
      ),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.completedMilestones).toEqual([]);
    expect(out.withdrawnRins).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('ambiguous_withdrawal');
  });
  it('holds an exact future withdrawal instead of terminating a forecast', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('Withdrawn', '09/29/2026'), '<RULE_STAGE>Completed Actions</RULE_STAGE>')),
      meta,
    );
    expect(out.withdrawnRins).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('future_withdrawal');
  });
  it('holds withdrawal without source run-date evidence', () => {
    const input = xml(
      row(action('Withdrawn', '09/29/2025'), '<RULE_STAGE>Completed Actions</RULE_STAGE>'),
    ).replace(' RUN_DATE="2026-07-03-04:00"', '');
    const out = parseUnifiedAgenda(input, meta);
    expect(out.withdrawnRins).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('unverified_withdrawal_clock');
  });
  it.each(['To Be Determined', '11/00/2026'])(
    'never turns a projected withdrawal %s into withdrawal',
    (date) => {
      const out = parseUnifiedAgenda(
        xml(row(action('Withdrawn', date), '<RULE_STAGE>Completed Actions</RULE_STAGE>')),
        meta,
      );
      expect(out.withdrawnRins).toEqual([]);
      expect(out.rejected[0]?.reason).toBe('ambiguous_withdrawal');
    },
  );
  it('holds a withdrawal contradicted by a later action', () => {
    const out = parseUnifiedAgenda(
      xml(
        row(
          action('Withdrawn', '09/29/2026') + action('NPRM', '10/15/2026'),
          '<RULE_STAGE>Completed Actions</RULE_STAGE>',
        ),
      ),
      meta,
    );
    expect(out.withdrawnRins).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('ambiguous_withdrawal');
  });
  it('does not infer a withdrawal from an unrelated entry or elapsed window', () => {
    const out = parseUnifiedAgenda(xml(row(action('NPRM', '01/00/2020'))), meta);
    expect(out.candidates).toHaveLength(1);
    expect(out.withdrawnRins).toEqual([]);
  });
  it('holds duplicate RINs without admitting either copy', () => {
    const input = row(action('NPRM', '11/00/2026'));
    const out = parseUnifiedAgenda(xml(input + input), meta);
    expect(out.candidates).toEqual([]);
    expect(out.rejected.map((r) => r.reason)).toEqual(['duplicate_rin', 'duplicate_rin']);
  });
  it('does not silently derive edition from filename or current year', () => {
    const out = parseUnifiedAgenda(xml(row(action('NPRM', '11/00/2026'))), { edition: '202601' });
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('edition_mismatch');
  });
  it('rejects a projected row carrying a confirmed Federal Register citation', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('NPRM', '11/00/2026', '<FR_CITATION>99 FR 1</FR_CITATION>'))),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('invalid_proposed_rule_projection');
  });
  it.each(['2026-02-30', '2026-11-01T00:00:00Z', 'yesterday'])(
    'rejects invalid supplied publication date %s',
    (issuedAt) => {
      expect(() =>
        parseUnifiedAgenda(xml(row(action('NPRM', '11/00/2026'))), { ...meta, issuedAt }),
      ).toThrow();
    },
  );
  it.each(['2026-11-01', '2028-02-29'])(
    'preserves valid externally supplied publication civil date %s',
    (issuedAt) => {
      expect(
        parseUnifiedAgenda(xml(row(action('NPRM', '11/00/2026'))), { ...meta, issuedAt })
          .candidates[0]?.source.issuedAt,
      ).toBe(issuedAt);
    },
  );
  it('holds an unknown rule stage', () => {
    const out = parseUnifiedAgenda(
      xml(row(action('NPRM', '11/00/2026'), '<RULE_STAGE>Unknown Stage</RULE_STAGE>')),
      meta,
    );
    expect(out.candidates).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('unsupported_rule_stage');
  });
  it.each([
    '<x/>',
    '<REGINFO_RIN_DATA/>',
    '<REGINFO_RIN_DATA>',
    '<!DOCTYPE x [<!ENTITY a "x">]><x/>',
  ])('rejects malformed or unsupported XML', (input) => {
    expect(() => parseUnifiedAgenda(input, meta)).toThrow();
  });
});
