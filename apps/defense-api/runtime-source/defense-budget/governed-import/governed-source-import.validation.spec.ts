import {
  armyRdteOfficialUrl,
  armyRdteTitle,
  ARMY_RDTE_VOLUME_CATALOG,
} from '@capiro/defense-domain';
import {
  validateGovernedImportRequest,
  type GovernedImportBundleMemberFacts,
  type GovernedImportExpectedSourceFacts,
  type GovernedImportRequestInput,
} from './governed-source-import.validation.js';

const FY = 2024;
const VOL1_BA1 = ARMY_RDTE_VOLUME_CATALOG.find((e) => e.memberKey === 'volume_1_ba_1')!;
const OFFICIAL_URL = armyRdteOfficialUrl(VOL1_BA1, FY);
const TITLE = armyRdteTitle(VOL1_BA1, FY);

const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('x'.repeat(64))]);
const HTML_BLOCK_PAGE = Buffer.from(
  '<!DOCTYPE html><html><head><title>Access Denied</title></head><body>Access Denied</body></html>',
);
const RANDOM_GARBAGE = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);

const EXPECTED_SOURCE: GovernedImportExpectedSourceFacts = {
  id: 'expected-source-1',
  fiscalYear: FY,
  authorityTrack: 'request',
  stage: 'president_budget_request',
  sourceFamily: 'pb_r2',
  component: 'ARMY',
  adapterId: 'army-budget',
};

const BUNDLE_MEMBER: GovernedImportBundleMemberFacts = {
  id: 'member-1',
  expectedSourceId: 'expected-source-1',
  memberKey: VOL1_BA1.memberKey,
  officialUrl: OFFICIAL_URL,
  title: TITLE,
  required: true,
  memberStatus: 'missing',
  boundContentSha256: null,
};

function baseInput(
  overrides: Partial<GovernedImportRequestInput> = {},
): GovernedImportRequestInput {
  return {
    expectedSource: EXPECTED_SOURCE,
    bundleMember: BUNDLE_MEMBER,
    siblingMembers: [],
    officialUrlArg: OFFICIAL_URL,
    fileBytes: PDF_BYTES,
    actor: 'neo@capiro.ai',
    reason: 'production fetch blocked by Akamai; operator-obtained official bytes',
    ...overrides,
  };
}

describe('validateGovernedImportRequest — Phase 10B-18 Part G/M', () => {
  it('accepts the real Volume 1 / Budget Activity 1 request and computes its sha256', () => {
    const result = validateGovernedImportRequest(baseInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.byteSize).toBe(PDF_BYTES.byteLength);
      expect(result.contentSha256).toHaveLength(64);
    }
  });

  it('requires a non-empty operator identity', () => {
    const result = validateGovernedImportRequest(baseInput({ actor: '   ' }));
    expect(result).toMatchObject({ ok: false, code: 'operator_identity_required' });
  });

  it('requires a non-empty reason', () => {
    const result = validateGovernedImportRequest(baseInput({ reason: '' }));
    expect(result).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('refuses a member that belongs to a different expected source', () => {
    const result = validateGovernedImportRequest(
      baseInput({
        bundleMember: { ...BUNDLE_MEMBER, expectedSourceId: 'some-other-expected-source' },
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      code: 'member_belongs_to_different_expected_source',
    });
  });

  it('refuses an --official-url that does not match the registered member URL', () => {
    const result = validateGovernedImportRequest(
      baseInput({
        officialUrlArg: 'https://www.asafm.army.mil/Portals/72/Documents/some-other-file.pdf',
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'official_url_argument_mismatch' });
  });

  it('refuses a non-Army / non-official host even if it matches the member field bytewise', () => {
    const evilUrl = 'https://evil.example.com/RDTE-Vol%201-Budget%20Activity%201.pdf';
    const result = validateGovernedImportRequest(
      baseInput({
        officialUrlArg: evilUrl,
        bundleMember: { ...BUNDLE_MEMBER, officialUrl: evilUrl },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'non_official_host' });
  });

  it('refuses an empty file', () => {
    const result = validateGovernedImportRequest(baseInput({ fileBytes: Buffer.alloc(0) }));
    expect(result).toMatchObject({ ok: false, code: 'empty_file' });
  });

  it('refuses an HTML/WAF block page (the real Akamai 403 shape) rather than accepting it as a PDF', () => {
    const result = validateGovernedImportRequest(baseInput({ fileBytes: HTML_BLOCK_PAGE }));
    expect(result).toMatchObject({ ok: false, code: 'html_or_waf_block_page' });
  });

  it('refuses arbitrary bytes that are neither a PDF nor HTML', () => {
    const result = validateGovernedImportRequest(baseInput({ fileBytes: RANDOM_GARBAGE }));
    expect(result).toMatchObject({ ok: false, code: 'not_a_pdf' });
  });

  it('refuses a document whose title/URL resolve to the wrong fiscal year', () => {
    const wrongYearEntry = VOL1_BA1;
    const wrongYearUrl = armyRdteOfficialUrl(wrongYearEntry, 2025);
    const wrongYearTitle = armyRdteTitle(wrongYearEntry, 2025);
    const result = validateGovernedImportRequest(
      baseInput({
        officialUrlArg: wrongYearUrl,
        bundleMember: { ...BUNDLE_MEMBER, officialUrl: wrongYearUrl, title: wrongYearTitle },
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'wrong_fiscal_year' });
  });

  it('refuses a document whose title resolves to a different source family than pb_r2', () => {
    const r1Title =
      'Department of the Army Fiscal Year 2024 Budget Estimates: RDT&E Program Element List (R-1)';
    const result = validateGovernedImportRequest(
      baseInput({ bundleMember: { ...BUNDLE_MEMBER, title: r1Title } }),
    );
    expect(result).toMatchObject({ ok: false, code: 'wrong_source_family' });
  });

  it('refuses a member already bound to a different sha256 (fail closed, no supersession workflow)', () => {
    const differentBytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from('y'.repeat(64))]);
    const boundResult = validateGovernedImportRequest(baseInput({ fileBytes: differentBytes }));
    expect(boundResult.ok).toBe(true);
    if (!boundResult.ok) return;

    const result = validateGovernedImportRequest(
      baseInput({
        bundleMember: {
          ...BUNDLE_MEMBER,
          memberStatus: 'verified',
          boundContentSha256: boundResult.contentSha256,
        },
        fileBytes: PDF_BYTES, // different bytes than what's already bound
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'member_already_bound_to_different_sha' });
  });

  it('accepts an exact replay: same member, same bytes already bound', () => {
    const accepted = validateGovernedImportRequest(baseInput());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const replay = validateGovernedImportRequest(
      baseInput({
        bundleMember: {
          ...BUNDLE_MEMBER,
          memberStatus: 'verified',
          boundContentSha256: accepted.contentSha256,
        },
      }),
    );
    expect(replay.ok).toBe(true);
  });

  it('refuses the same bytes already bound to a DIFFERENT member (never silently assumes duplicate)', () => {
    const accepted = validateGovernedImportRequest(baseInput());
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;

    const result = validateGovernedImportRequest(
      baseInput({
        siblingMembers: [
          {
            memberKey: 'volume_1_ba_2',
            required: true,
            memberStatus: 'verified',
            boundContentSha256: accepted.contentSha256,
          },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false, code: 'sha_already_bound_to_different_member' });
  });
});

// Synthetic signatures exercise local host/identity validation only. They are
// not publisher bytes, source qualification, or governed source admission.
describe('existing Navy governed validation parity', () => {
  const navy = (url: string): GovernedImportRequestInput =>
    baseInput({
      expectedSource: { ...EXPECTED_SOURCE, adapterId: 'navy-budget', component: 'NAVY' },
      officialUrlArg: url,
      bundleMember: {
        ...BUNDLE_MEMBER,
        officialUrl: url,
        title:
          'Department of the Navy Fiscal Year 2024 Budget Estimates Research Development Test and Evaluation R-2 Budget Activity 1',
      },
    });
  it.each(['secnav.navy.mil', 'www.secnav.navy.mil'])(
    'accepts the existing registered HTTPS Navy host %s without side effects',
    (host) => {
      expect(
        validateGovernedImportRequest(navy('https://' + host + '/Budget/2024/R2-Volume-1.pdf')).ok,
      ).toBe(true);
    },
  );
  it.each([
    'http://secnav.navy.mil/Budget/2024/R2.pdf',
    'https://secnav.navy.mil.evil.example/Budget/2024/R2.pdf',
    'https://asafm.army.mil/Budget/2024/R2.pdf',
  ])('refuses insecure, deceptive or different-adapter host %s', (url) => {
    expect(validateGovernedImportRequest(navy(url))).toMatchObject({
      ok: false,
      code: 'non_official_host',
    });
  });
  it('keeps unsupported adapters fail closed and retains component identity guard', () => {
    const input = navy('https://secnav.navy.mil/Budget/2024/R2.pdf');
    expect(
      validateGovernedImportRequest({
        ...input,
        expectedSource: { ...input.expectedSource, adapterId: 'saf-fm-budget' },
      }),
    ).toMatchObject({ ok: false, code: 'non_official_host' });
    expect(
      validateGovernedImportRequest({
        ...input,
        expectedSource: { ...input.expectedSource, component: 'ARMY' },
      }),
    ).toMatchObject({ ok: false, code: 'wrong_component' });
  });
});
