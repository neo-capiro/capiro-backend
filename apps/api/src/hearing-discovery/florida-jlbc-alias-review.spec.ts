import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FLORIDA_JLBC_ALIAS_REVIEW,
  validateFloridaJlbcAliasReview,
  verifyFloridaJlbcOfficialProof,
  type FloridaJlbcAliasReview,
} from './florida-jlbc-alias-review.js';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(__dirname, '__fixtures__/florida', name)));

function monthlyPage(location = '110 SOB'): string {
  return `
    <div class="meeting-day">
      <h5 class="card-header">Friday, September 11, 2026</h5>
      <div class="meeting-notice">
        <h3 class="committee-title">Joint Legislative Budget Commission</h3>
        <div class="details">
          <div><span class="label">Meeting Start Time:</span><span class="value">09/11/2026 11:00 AM</span></div>
          <div><span class="label">Meeting End Time:</span><span class="value">09/11/2026 02:00 PM</span></div>
          <div><span class="label">Location:</span><span class="value">${location}</span></div>
        </div>
        <div class="meeting-notice-details">${FLORIDA_JLBC_ALIAS_REVIEW.agenda.join('\n')}</div>
      </div>
    </div>`;
}

describe('exact Florida JLBC alias proof', () => {
  it('validates all three first-party publications and the full agenda', async () => {
    const requested: string[] = [];
    const fetchPage = jest.fn(async (url: string) => {
      requested.push(url);
      if (url === FLORIDA_JLBC_ALIAS_REVIEW.houseMonthlyUrl)
        return new TextEncoder().encode(monthlyPage());
      if (url === FLORIDA_JLBC_ALIAS_REVIEW.houseNoticeUrl) return fixture('house-15223.html');
      if (url === FLORIDA_JLBC_ALIAS_REVIEW.senateNoticeUrl)
        return fixture('senate-notice-6914.pdf');
      throw new Error(`unexpected URL ${url}`);
    });
    const proof = await verifyFloridaJlbcOfficialProof(
      FLORIDA_JLBC_ALIAS_REVIEW,
      fetchPage,
      async (bytes) => {
        expect(Buffer.from(bytes)).toEqual(Buffer.from(fixture('senate-notice-6914.pdf')));
        return new TextDecoder().decode(fixture('senate-notice-6914.txt'));
      },
    );

    expect(requested).toEqual([
      FLORIDA_JLBC_ALIAS_REVIEW.houseMonthlyUrl,
      FLORIDA_JLBC_ALIAS_REVIEW.houseNoticeUrl,
      FLORIDA_JLBC_ALIAS_REVIEW.senateNoticeUrl,
    ]);
    expect(proof).toMatchObject({
      aliasId: 'state-fl-77380beb39c1f52d4b6e95765e6530bc',
      canonicalId: 'state-fl-fcc8b09689bcb41294daf87c22afaea3',
      externalEventId: 'ocd-event/a02f8006-d61c-436b-bd3b-e5080dad8f67',
      officialIdentity: 'fl:joint:lbc:notice:6914-15223',
      date: '2026-09-11',
      startsAt: '2026-09-11T15:00:00.000Z',
      endsAt: '2026-09-11T18:00:00.000Z',
    });
    expect(proof.agendaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(proof.proofHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a changed monthly location before any database work', async () => {
    await expect(
      verifyFloridaJlbcOfficialProof(
        FLORIDA_JLBC_ALIAS_REVIEW,
        async (url) => {
          if (url === FLORIDA_JLBC_ALIAS_REVIEW.houseMonthlyUrl)
            return new TextEncoder().encode(monthlyPage('Room changed'));
          if (url === FLORIDA_JLBC_ALIAS_REVIEW.houseNoticeUrl) return fixture('house-15223.html');
          return fixture('senate-notice-6914.pdf');
        },
        async () => new TextDecoder().decode(fixture('senate-notice-6914.txt')),
      ),
    ).rejects.toThrow('live House monthly date, time, or location changed');
  });

  it('does not accept an operator-supplied neighboring pair', () => {
    const changed = {
      ...FLORIDA_JLBC_ALIAS_REVIEW,
      canonicalId: `state-fl-${'a'.repeat(32)}`,
    } as FloridaJlbcAliasReview;
    expect(() => validateFloridaJlbcAliasReview(changed)).toThrow(
      'not the exact code-reviewed JLBC pair',
    );
  });
});
