import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractEmailsFromUnknown,
  matchRelationshipCandidate,
} from './client-profile-fill-relationship-history.service.js';

describe('Fill with Meri relationship-history matching', () => {
  it('accepts an exact known client contact and normalizes email casing', () => {
    expect(
      matchRelationshipCandidate(
        ['Executive@Example.COM', 'user@capiro.ai'],
        new Set(['executive@example.com']),
        new Set(['example.com']),
      ),
    ).toEqual({
      confidence: 0.98,
      matchedEmails: ['executive@example.com'],
      matchedDomains: ['example.com'],
      matchReason: 'known_client_contact',
    });
  });

  it('accepts official-domain participants without relying on the company name', () => {
    expect(
      matchRelationshipCandidate(
        ['one@example.com', 'two@example.com'],
        new Set(),
        new Set(['example.com']),
      ),
    ).toEqual({
      confidence: 0.95,
      matchedEmails: ['one@example.com', 'two@example.com'],
      matchedDomains: ['example.com'],
      matchReason: 'multiple_company_domain_participants',
    });
  });

  it('fails closed when no exact contact or official-domain anchor exists', () => {
    expect(
      matchRelationshipCandidate(
        ['person@gmail.com', 'someone@unrelated.test'],
        new Set(['other@example.com']),
        new Set(['example.com']),
      ),
    ).toBeNull();
  });

  it('extracts participant emails from nested provider metadata without message bodies', () => {
    expect(
      extractEmailsFromUnknown({
        from: { name: 'A', address: 'A@Example.com' },
        to: [{ emailAddress: { address: 'b@example.com' } }],
      }),
    ).toEqual(['a@example.com', 'b@example.com']);
  });
});

describe('Fill with Meri relationship-history architecture contract', () => {
  const service = readFileSync(
    resolve(process.cwd(), 'src/clients/client-profile-fill-relationship-history.service.ts'),
    'utf8',
  );
  const factory = readFileSync(
    resolve(process.cwd(), 'src/clients/governed-client-profile-fill.factory.ts'),
    'utf8',
  );
  const moduleSource = readFileSync(resolve(process.cwd(), 'src/clients/clients.module.ts'), 'utf8');
  const migration = readFileSync(
    resolve(
      process.cwd(),
      'prisma/migrations/20271231020000_client_profile_fill_relationship_history/migration.sql',
    ),
    'utf8',
  );

  it('reuses the durable synced-email specialist and review pipeline', () => {
    expect(factory).toContain('relationshipHistory.gather');
    expect(factory).toContain("String(finding.kind) === 'relationship_link'");
    expect(factory).toContain('relationshipHistory.apply');
    expect(moduleSource).toContain('ClientProfileFillRelationshipHistoryService');
  });

  it('queries only actor-owned unlinked meetings and mail threads', () => {
    expect(service).toContain('ownMeetingWhere(ctx.userId)');
    expect(service).toContain('ownMailThreadWhere(ctx.userId)');
    expect(service).toContain('clientId: null');
    expect(service).toContain('isInternal: false');
  });

  it('does not copy private source bodies into relationship findings', () => {
    expect(service).not.toContain('body: true');
    expect(service).not.toContain('bodyPreview: true');
    expect(service).not.toContain('snippet: true');
    expect(service).not.toContain('description: true');
    expect(service).toContain('participants: true');
    expect(service).toContain('attendees: { select: { email: true } }');
  });

  it('applies accepted links through the authoritative association override', () => {
    expect(service).toContain('this.engagement.overrideAssociation');
    expect(service).toContain('AssociationEntityType.meeting');
    expect(service).toContain('AssociationEntityType.mail_thread');
    expect(service).toContain('already associated with a different client');
    expect(service).not.toContain('clientActivity.create');
  });

  it('extends the finding check without removing existing finding kinds', () => {
    for (const kind of [
      'profile_field',
      'government_identity',
      'person',
      'facility',
      'capability',
      'lda_identity',
      'lda_history',
      'program_element',
      'bill_recommendation',
      'relationship_link',
    ]) {
      expect(migration).toContain(`'${kind}'`);
    }
  });
});
