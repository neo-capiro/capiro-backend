import {
  harvestMailContacts,
  harvestableParticipants,
  isHarvestableContact,
} from './contact-harvest.js';
import { websiteDomain } from '../meri/meri-tools.service.js';

/**
 * Mail-derived contact harvesting.
 *
 * engagement_contacts already existed and both syncs already wrote to it — but
 * only from CALENDAR ATTENDEES. Nobody harvested mail, so the contact table
 * knew whoever had been on an invite and nobody the firm had merely emailed for
 * months. Everything needed was already on mail_messages, so this needs no new
 * Graph/Google scope and no re-consent.
 */

describe('isHarvestableContact', () => {
  it('accepts real correspondents', () => {
    for (const e of ['jason@brycetech.com', 'a.carlock@reverefederal.com', 'first.last@dod.gov']) {
      expect([e, isHarvestableContact(e)]).toEqual([e, true]);
    }
  });

  it('rejects robots — filing noreply@ as a person is worse than not harvesting', () => {
    for (const e of [
      'noreply@stripe.com',
      'no-reply@github.com',
      'notifications@mercury.com',
      'mailer-daemon@google.com',
      'bounces+12345@sendgrid.net',
      'no-reply-calendar@microsoft.com',
      'bounce-99-user=example.com@mailer.net',
    ]) {
      expect([e, isHarvestableContact(e)]).toEqual([e, false]);
    }
  });

  it('rejects malformed addresses', () => {
    for (const e of ['', 'notanemail', 'user@', '@domain.com', 'user@localhost']) {
      expect([e, isHarvestableContact(e)]).toEqual([e, false]);
    }
  });
});

describe('harvestableParticipants', () => {
  it('dedupes by address, prefers a real display name, and sorts', () => {
    const rows = harvestableParticipants([
      { email: 'B@Example.com', name: null, role: 'to' },
      { email: 'b@example.com', name: 'Beta Person', role: 'cc' },
      { email: 'a@example.com', name: 'Alpha', role: 'from' },
      { email: 'noreply@example.com', name: 'Robot', role: 'to' },
    ]);
    expect(rows).toEqual([
      { email: 'a@example.com', name: 'Alpha' },
      { email: 'b@example.com', name: 'Beta Person' },
    ]);
  });
});

describe('harvestMailContacts', () => {
  it('writes ONE bounded statement — this runs under the sync advisory lock', async () => {
    // 2026-07-21: an advisory lock held across an extra per-row read starved
    // the Prisma pool (P2028) and took out the knowledge graph. A
    // findUnique-then-update loop per participant per message is that same
    // shape, so the in-transaction path must stay a single createMany.
    const createMany = jest.fn().mockResolvedValue({ count: 2 });
    const findUnique = jest.fn();
    const tx = { engagementContact: { createMany, findUnique } } as never;
    const count = await harvestMailContacts(
      tx,
      'tenant-1',
      [
        { email: 'a@example.com', name: 'Alpha', role: 'from' },
        { email: 'b@example.com', name: 'Beta', role: 'to' },
      ],
      { source: 'google', clientId: 'client-1' },
    );
    expect(count).toBe(2);
    expect(createMany).toHaveBeenCalledTimes(1);
    expect(findUnique).not.toHaveBeenCalled();
    expect(createMany.mock.calls[0]?.[0]).toMatchObject({ skipDuplicates: true });
  });

  it('does nothing when every participant is a robot', async () => {
    const createMany = jest.fn();
    const tx = { engagementContact: { createMany } } as never;
    const count = await harvestMailContacts(
      tx,
      'tenant-1',
      [{ email: 'noreply@stripe.com', name: 'Stripe', role: 'from' }],
      { source: 'google' },
    );
    expect(count).toBe(0);
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe('websiteDomain', () => {
  it('reduces a website to the host used for contact matching', () => {
    expect(websiteDomain('https://www.brycetech.com/about')).toBe('brycetech.com');
    expect(websiteDomain('http://ballardpartners.com')).toBe('ballardpartners.com');
    expect(websiteDomain('legistorm.com')).toBe('legistorm.com');
    expect(websiteDomain('https://foo.co.uk:8443/x?y=1')).toBe('foo.co.uk');
  });

  it('refuses free-mail hosts — a shared domain says nothing about employment', () => {
    // Otherwise one client listing gmail.com would claim every Gmail
    // correspondent in the tenant.
    expect(websiteDomain('https://gmail.com')).toBeNull();
    expect(websiteDomain('outlook.com')).toBeNull();
  });

  it('returns null for junk', () => {
    expect(websiteDomain(null)).toBeNull();
    expect(websiteDomain('')).toBeNull();
    expect(websiteDomain('not a url')).toBeNull();
  });
});
