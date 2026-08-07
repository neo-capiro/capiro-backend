import { describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { IntelligenceController } from './intelligence.controller.js';
import { AWARD_BEARING_MAPPING_SOURCES, IntelligenceService } from './intelligence.service.js';

/**
 * P05 — mapping governance.
 *
 * A `ClientIntelMapping` on an award-bearing source is the answer to "whose money
 * is this". Confirming one attributes federal award history to a client; rejecting
 * one durably removes history the client may be entitled to. Both directions are
 * consequential, and before P05 both could be reached by a bulk toggle sending
 * `{confirmed}` and nothing else, by a `standard_user`.
 *
 * Every test here maps to one of the phase's acceptance criteria.
 */

const TENANT = '00000000-0000-0000-0000-000000000001';
const CLIENT = '00000000-0000-0000-0000-000000000010';
const ACTOR = '00000000-0000-0000-0000-000000000099';
const MAPPING = '00000000-0000-0000-0000-0000000000aa';

/** Minimal prisma double: one mapping row, tenant-scoped reads, capture writes. */
function makePrisma(existing: Record<string, unknown> | null) {
  const updates: any[] = [];
  const audits: any[] = [];
  const tx = {
    clientIntelMapping: {
      findUnique: jest.fn(async () => existing),
      update: jest.fn(async (args: any) => {
        updates.push(args);
        return { id: MAPPING, ...(existing ?? {}), ...args.data };
      }),
    },
    client: {
      findFirst: jest.fn(async () => (existing ? { id: CLIENT } : null)),
    },
    auditLog: {
      create: jest.fn(async (args: any) => {
        audits.push(args.data);
        return args.data;
      }),
    },
  };
  const prisma: any = {
    withTenant: jest.fn(async (_t: string, run: (t: any) => Promise<unknown>) => run(tx)),
  };
  return { prisma, tx, updates, audits };
}

function mappingRow(over: Record<string, unknown> = {}) {
  return {
    id: MAPPING,
    tenantId: TENANT,
    clientId: CLIENT,
    source: 'contracting',
    externalId: '11111111-1111-1111-1111-111111111111',
    externalName: 'Acme Defense LLC',
    confirmed: false,
    reviewStatus: 'candidate',
    relationshipType: null,
    rollUpAwards: null,
    rejectionReason: null,
    matchBasis: 'exact_legal_name',
    matchTier: 2,
    ...over,
  };
}

// ── Acceptance: the DTO whitelist rejects a body `id` ────────────────────────

describe('the mapping id comes from the path, and only the path', () => {
  /** The DTO is not exported, so it is reached through the route's metadata. */
  function confirmDto() {
    const types = Reflect.getMetadata(
      'design:paramtypes',
      IntelligenceController.prototype,
      'confirmMapping',
    ) as unknown[];
    // (ctx, mappingId, body) — the DTO is the third parameter.
    return types[2] as new () => object;
  }

  test('a well-formed body validates', async () => {
    const dto = plainToInstance(confirmDto(), {
      confirmed: true,
      relationshipType: 'self',
      rollUpAwards: true,
    });
    expect(await validate(dto, { whitelist: true, forbidNonWhitelisted: true })).toEqual([]);
  });

  test('a body carrying an `id` is REJECTED', async () => {
    // Two sources of truth about which row to write is how a request ends up
    // updating a mapping other than the one in its own URL. The global pipe runs
    // forbidNonWhitelisted, so declaring no `id` is what makes this a 400.
    const dto = plainToInstance(confirmDto(), { id: MAPPING, confirmed: true });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).not.toEqual([]);
    expect(JSON.stringify(errors)).toContain('id');
  });

  test('the web client does not send `id` in the body', () => {
    // It did, and every call from that page was in fact 400ing. The page's own
    // tests mock axios, so they could not see it.
    const src = readFileSync(
      join(__dirname, '../../../web/src/pages/settings/IntelligenceMappingsPage.tsx'),
      'utf8',
    );
    // The id must be destructured out of the payload before the PATCH.
    expect(src).toMatch(/api\.patch\(`\/api\/intelligence\/mappings\/\$\{id\}`,\s*body\)/);
    expect(src).not.toMatch(/mappings\/\$\{input\.id\}`,\s*input\)/);
  });
});

// ── Acceptance: missing relationship type or roll-up choice returns 400 ──────

describe('award-bearing identity may only be decided explicitly', () => {
  test('the award-bearing set is exactly the two money-attributing sources', () => {
    expect([...AWARD_BEARING_MAPPING_SOURCES].sort()).toEqual([
      'assistance_recipient',
      'contracting',
    ]);
  });

  test.each([...AWARD_BEARING_MAPPING_SOURCES])(
    'confirming %s without a relationship type is a 400',
    async (source) => {
      const { prisma } = makePrisma(mappingRow({ source }));
      const service = new IntelligenceService(prisma);
      await expect(
        service.confirmMapping(MAPPING, { confirmed: true, rollUpAwards: true, actorUserId: ACTOR }, TENANT),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  test.each([...AWARD_BEARING_MAPPING_SOURCES])(
    'confirming %s without a roll-up choice is a 400',
    async (source) => {
      const { prisma } = makePrisma(mappingRow({ source }));
      const service = new IntelligenceService(prisma);
      await expect(
        service.confirmMapping(
          MAPPING,
          { confirmed: true, relationshipType: 'self', actorUserId: ACTOR },
          TENANT,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  test('a bare {confirmed:true} — what a bulk toggle sends — is a 400', async () => {
    const { prisma, updates } = makePrisma(mappingRow());
    const service = new IntelligenceService(prisma);
    await expect(
      service.confirmMapping(MAPPING, { confirmed: true, actorUserId: ACTOR }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  test('the decision may NOT be inherited from a previous one', async () => {
    // The old guard read `input.relationshipType ?? existing.relationshipType`, so
    // a row that already carried values satisfied it and a re-confirm silently
    // reused a decision made at some other time, for some other reason, possibly
    // by someone else. An already-decided row is not consent for the next decision.
    const { prisma, updates } = makePrisma(
      mappingRow({ relationshipType: 'parent', rollUpAwards: true }),
    );
    const service = new IntelligenceService(prisma);
    await expect(
      service.confirmMapping(MAPPING, { confirmed: true, actorUserId: ACTOR }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  test('an explicit rollUpAwards:false is a real answer, not a missing one', async () => {
    // `false` is a decision — "this relationship exists and its awards are NOT the
    // client's". A guard written with a falsy check would reject the one answer
    // that most needs recording.
    const { prisma, updates } = makePrisma(mappingRow());
    const service = new IntelligenceService(prisma);
    await service.confirmMapping(
      MAPPING,
      { confirmed: true, relationshipType: 'subsidiary', rollUpAwards: false, actorUserId: ACTOR },
      TENANT,
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].data).toMatchObject({
      confirmed: true,
      reviewStatus: 'confirmed',
      relationshipType: 'subsidiary',
      rollUpAwards: false,
    });
  });

  test('a non-award-bearing source still confirms with a bare body', async () => {
    // The gate is scoped to money attribution. An `lda` link makes no such claim,
    // and widening the gate would make routine reference work admin-only for no
    // safety gain.
    const { prisma, updates } = makePrisma(mappingRow({ source: 'lda' }));
    const service = new IntelligenceService(prisma);
    await service.confirmMapping(MAPPING, { confirmed: true, actorUserId: ACTOR }, TENANT);
    expect(updates[0].data).toMatchObject({ confirmed: true, reviewStatus: 'confirmed' });
  });
});

// ── Acceptance: bulk actions cannot mutate an award-bearing mapping ──────────

describe('a bulk sweep cannot reach an award-bearing mapping, in either direction', () => {
  test.each([...AWARD_BEARING_MAPPING_SOURCES])(
    'rejecting %s without a written reason is a 400',
    async (source) => {
      // A reject is a single PATCH, so the server cannot tell a bulk sweep from an
      // individual decision. Requiring a reason is what a sweep cannot supply —
      // and a durable rejection with no recorded reason is unreviewable later.
      const { prisma, updates } = makePrisma(mappingRow({ source }));
      const service = new IntelligenceService(prisma);
      await expect(
        service.confirmMapping(MAPPING, { confirmed: false, actorUserId: ACTOR }, TENANT),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(updates).toHaveLength(0);
    },
  );

  test('a whitespace-only reason does not count as a reason', async () => {
    const { prisma } = makePrisma(mappingRow());
    const service = new IntelligenceService(prisma);
    await expect(
      service.confirmMapping(
        MAPPING,
        { confirmed: false, rejectionReason: '   ', actorUserId: ACTOR },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('a reasoned rejection records reason, actor and timestamp', async () => {
    const { prisma, updates, audits } = makePrisma(mappingRow());
    const service = new IntelligenceService(prisma);
    await service.confirmMapping(
      MAPPING,
      { confirmed: false, rejectionReason: 'Different company, same name', actorUserId: ACTOR },
      TENANT,
    );
    expect(updates[0].data).toMatchObject({
      confirmed: false,
      reviewStatus: 'rejected',
      rejectionReason: 'Different company, same name',
      reviewedBy: ACTOR,
    });
    expect(updates[0].data.reviewedAt).toBeInstanceOf(Date);
    // Same transaction as the write — an audit row written afterwards can be lost.
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'intelligence_mapping.rejected',
      entityType: 'client_intel_mapping',
      actorUserId: ACTOR,
    });
  });

  test('a low-confidence bulk reject cannot sweep an award-bearing row', () => {
    // Server-side the guard above does it. Client-side the loop must also exclude
    // them, or every sweep produces a wall of 400s and the operator learns to
    // ignore errors. Both halves are required; this asserts the client half.
    const src = readFileSync(
      join(__dirname, '../../../web/src/pages/settings/IntelligenceMappingsPage.tsx'),
      'utf8',
    );
    const rejectAll = src.slice(src.indexOf('async function handleRejectAll'));
    const body = rejectAll.slice(0, rejectAll.indexOf('\n  }\n'));
    expect(body).toContain('REQUIRES_INDIVIDUAL_REVIEW');
  });

  test('bulk confirm still excludes them too', () => {
    const src = readFileSync(
      join(__dirname, '../../../web/src/pages/settings/IntelligenceMappingsPage.tsx'),
      'utf8',
    );
    const confirmAll = src.slice(src.indexOf('async function handleConfirmAll'));
    const body = confirmAll.slice(0, confirmAll.indexOf('\n  }\n'));
    expect(body).toContain('REQUIRES_INDIVIDUAL_REVIEW');
  });
});

// ── Acceptance: rejected candidates stay rejected ───────────────────────────

describe('a rejection survives an entity-resolution rerun', () => {
  test('persistSourceCandidates skips a rejected row', () => {
    const src = readFileSync(join(__dirname, 'entity-resolution.service.ts'), 'utf8');
    expect(src).toMatch(/existing\?\.reviewStatus === 'rejected'/);
  });

  test('the prune script does NOT hard-delete a rejected row', () => {
    // The real hole. That script selects `confirmed = false` and DELETEs, and a
    // rejected row is confirmed=false — so a prune erased the rejection itself,
    // after which persistSourceCandidates found no `existing`, its rejected-guard
    // had nothing to read, and the refused candidate came straight back.
    const src = readFileSync(
      join(__dirname, '../../scripts/prune-stale-assistance-recipient-candidates.ts'),
      'utf8',
    );
    const deletes = src.includes('clientIntelMapping.delete');
    expect(deletes).toBe(true);
    const guards = src.match(/review_status <> 'rejected'/g) ?? [];
    const selects = src.match(/m\.confirmed = false/g) ?? [];
    // Every candidate-selecting query must carry the guard, not just one branch.
    expect(guards.length).toBe(selects.length);
    expect(guards.length).toBeGreaterThan(0);
  });
});

// ── Acceptance: cross-tenant and portal-user negative tests ─────────────────

describe('tenant isolation and role gating', () => {
  test('a mapping in another tenant is not found, not silently updated', async () => {
    // The read runs inside withTenant, and the client-ownership check is what turns
    // a cross-tenant id into a 404 rather than a write.
    const { prisma, updates } = makePrisma(null);
    const service = new IntelligenceService(prisma);
    await expect(
      service.confirmMapping(
        MAPPING,
        { confirmed: true, relationshipType: 'self', rollUpAwards: true, actorUserId: ACTOR },
        TENANT,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(updates).toHaveLength(0);
  });

  test('the write is tenant-scoped', async () => {
    const { prisma } = makePrisma(mappingRow());
    const service = new IntelligenceService(prisma);
    await service.confirmMapping(
      MAPPING,
      { confirmed: true, relationshipType: 'self', rollUpAwards: true, actorUserId: ACTOR },
      TENANT,
    );
    expect(prisma.withTenant).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });

  test('confirmMapping requires user_admin', () => {
    // It inherited standard_user from the class, which put approving a federal
    // award-attribution claim at the same rank as saving an opportunity — while the
    // two neighbouring routes writing the same column already required user_admin.
    const declared = Reflect.getMetadata(
      ROLES_KEY,
      IntelligenceController.prototype.confirmMapping,
    );
    expect(declared).toEqual(['user_admin']);
  });

  function contextFor(role: string) {
    return {
      getHandler: () => IntelligenceController.prototype.confirmMapping,
      getClass: () => IntelligenceController,
      switchToHttp: () => ({
        getRequest: () => ({ tenantContext: { tenantId: TENANT, userId: ACTOR, role } }),
      }),
    } as unknown as ExecutionContext;
  }

  const guard = new RolesGuard(new Reflector());

  test.each(['client_portal_user', 'standard_user'])('%s is DENIED', (role) => {
    expect(() => guard.canActivate(contextFor(role))).toThrow(ForbiddenException);
  });

  test.each(['user_admin', 'capiro_admin'])('%s is allowed', (role) => {
    expect(guard.canActivate(contextFor(role))).toBe(true);
  });

  test('an unrecognized role fails CLOSED', () => {
    expect(() => guard.canActivate(contextFor('legacy_owner'))).toThrow(ForbiddenException);
  });
});

// ── Acceptance: the page explains why individual review is required ──────────

describe('the page explains the constraint rather than just enforcing it', () => {
  const src = readFileSync(
    join(__dirname, '../../../web/src/pages/settings/IntelligenceMappingsPage.tsx'),
    'utf8',
  );

  test('both bulk buttons carry an explanation of what they skip', () => {
    // Matched on the rendered LABEL, not the bare phrase: the phrase also appears
    // in the source comment documenting the 2026-07-27 incident, and matching that
    // would make this test pass on prose rather than on UI.
    for (const label of ['Confirm All ≥ 60%', 'Reject All &lt; 50%']) {
      const at = src.indexOf(label);
      expect(at).toBeGreaterThan(-1);
      // A Tooltip wraps each button; look back far enough to find its opening tag.
      expect(src.slice(Math.max(0, at - 900), at)).toContain('<Tooltip');
    }
  });

  test('an award-bearing row shows "Review individually" instead of a bare toggle', () => {
    // A toggle sends only {confirmed}, which the API now refuses. Offering one
    // would be an affordance that cannot succeed.
    expect(src).toContain('AWARD_BEARING_SOURCES');
    expect(src).toContain('Review individually');
  });

  test('the web mirror of the award-bearing set matches the API', () => {
    const mirrored = /const AWARD_BEARING_SOURCES = new Set<string>\(\[([^\]]*)\]\)/.exec(src);
    expect(mirrored).not.toBeNull();
    const values = [...mirrored![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!).sort();
    expect(values).toEqual([...AWARD_BEARING_MAPPING_SOURCES].sort());
  });
});
