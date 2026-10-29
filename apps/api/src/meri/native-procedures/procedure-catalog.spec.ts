import { NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import { ROLES_KEY } from '../../auth/roles.decorator.js';
import { MeriController } from '../meri.controller.js';
import { MeriProcedureRuntimeValidationService } from '../meri-procedure-runtime-validation.service.js';
import { procedureManifestDigest } from '../meri-procedure-runtime.js';
import type { MeriProcedureManifest, MeriSkill } from '../skills/skill.types.js';
import {
  MERI_BUILTIN_PROCEDURE_IDS,
  MERI_BUILTIN_PROCEDURES,
  builtinProcedureDigest,
  parseSelectedProcedureSelector,
  resolveSelectedProcedureAdmission,
  type MeriBuiltinProcedureId,
} from './selected-procedure.js';
import { projectProcedureCatalog, type MeriFirmProcedureCatalogRow } from './procedure-catalog.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const ctx = { tenantId: TENANT, userId: USER } as TenantContext;

const firmManifest: MeriProcedureManifest = {
  purpose: 'Audit a client commitment set from authorized evidence.',
  scopes: ['general', 'client'],
  evidencePrerequisites: ['An authorized client', 'An audit window'],
  allowedCapabilities: ['client.read'],
  output: {
    fields: ['promise', 'auditStatus', 'citations'],
    statuses: ['completed', 'in progress', 'no record of action'],
    coverageStates: ['checked', 'unavailable'],
    unknownValue: 'unknown',
    preserveModality: true,
    honorRequestedWindow: true,
    defaultRecentWindowDays: null,
    reportPartialCoverage: true,
  },
  completion: ['Require delivery or acceptance evidence for completed'],
  effectPolicy: { mode: 'read_only', prohibitedEffects: ['send a message'] },
  examples: ['A may-suggestion is not a confirmed obligation.'],
  caseIds: ['CD-01'],
};
const firmDigest = procedureManifestDigest(firmManifest);
const firmSkill: MeriSkill = {
  id: 'commitments_audit',
  name: 'Commitments & Deliverables',
  triggers: ['commitments_audit'],
  systemAddendum: 'Audit evidenced commitments read-only.',
  requiredTools: ['get_client_context'],
  template: { heading: 'Commitments & Deliverables', sections: ['Commitments'] },
  procedure: firmManifest,
  procedureBinding: { source: 'firm', recordId: 'row-1', canonicalId: 'commitments_audit', version: 3 },
};

/** Mirrors the exact shape MeriFirmSkillsService.list() returns per row. */
function firmRow(overrides: Record<string, unknown> = {}): MeriFirmProcedureCatalogRow {
  return {
    id: 'row-1',
    skillId: 'commitments_audit',
    name: 'Commitments & Deliverables',
    skill: firmSkill,
    version: 3,
    versions: [],
    enabled: true,
    runnable: true,
    procedureDigest: firmDigest,
    procedureScopes: ['general', 'client'],
    validationErrors: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as unknown as MeriFirmProcedureCatalogRow;
}

/** Existing-owner boundary double: only the firm-skill owner's two methods are mocked. */
function ownerDouble(rows: MeriFirmProcedureCatalogRow[], resolved: MeriSkill = firmSkill) {
  const list = jest.fn(async () => rows);
  const resolveProcedureReference = jest.fn(async () => resolved);
  return { firmSkills: { list, resolveProcedureReference }, list, resolveProcedureReference };
}

function catalog(firmRows: MeriFirmProcedureCatalogRow[] = []) {
  return projectProcedureCatalog({ tenantId: TENANT, firmRows, now: 1_000 });
}

describe('procedure catalog (MO01/ST16)', () => {
  describe('the six canonical builtins', () => {
    it('offers exactly the six canonical ids at their exact version and digest', () => {
      const result = catalog();
      expect(result.counts).toEqual({ builtin: 6, firm: 0, total: 6 });
      expect(result.tenantId).toBe(TENANT);
      expect(result.version).toBe(1);

      expect(result.entries.map((entry) => entry.display.id)).toEqual([
        ...MERI_BUILTIN_PROCEDURE_IDS,
      ]);
      MERI_BUILTIN_PROCEDURE_IDS.forEach((id, index) => {
        const entry = result.entries[index]!;
        const descriptor = MERI_BUILTIN_PROCEDURES[id];
        expect(entry.selector).toEqual({
          source: 'builtin',
          id,
          version: descriptor.version,
          manifestDigest: builtinProcedureDigest(id),
        });
        // Display metadata is derived from the canonical descriptor.
        expect(entry.display).toEqual({
          id,
          canonicalId: id,
          label: id,
          purpose: descriptor.manifest.purpose,
          scopes: descriptor.manifest.scopes,
        });
        // Closed shape: the canonical parser accepts every emitted selector.
        expect(parseSelectedProcedureSelector(entry.selector)).toEqual(entry.selector);
      });
    });

    it('carries no instructions, tools, grant, budget, approval or private projection', () => {
      const serialized = JSON.stringify(catalog([firmRow()]));
      for (const forbidden of [
        'instruction',
        'systemAddendum',
        'allowedTools',
        'requiredTools',
        'prohibitedEffects',
        'effectMode',
        'validationErrors',
        'grant',
        'budget',
        'approval',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      // The public entry surface is exactly selector + display.
      for (const entry of catalog([firmRow()]).entries) {
        expect(Object.keys(entry).sort()).toEqual(['display', 'selector']);
        expect(Object.keys(entry.display).sort()).toEqual([
          'canonicalId',
          'id',
          'label',
          'purpose',
          'scopes',
        ]);
      }
      // Immutable, so nothing downstream can widen the offered set.
      const result = catalog();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.entries)).toBe(true);
      expect(Object.isFrozen(result.entries[0]!.selector)).toBe(true);
    });

    it.each([...MERI_BUILTIN_PROCEDURE_IDS])(
      'round-trips the %s selector through the real resolver with its exact digest',
      async (id) => {
        const entry = catalog().entries.find(
          (candidate) => (candidate.selector as { id?: string }).id === id,
        )!;
        const h = ownerDouble([]);
        const admission = await resolveSelectedProcedureAdmission({
          ctx,
          clientId: CLIENT,
          selector: entry.selector,
          firmSkills: h.firmSkills as never,
          now: 2_000,
        });
        expect(admission.manifestDigest).toBe(entry.selector.manifestDigest);
        expect(admission.identity).toEqual({
          source: 'builtin',
          id,
          canonicalId: id,
          version: MERI_BUILTIN_PROCEDURES[id as MeriBuiltinProcedureId].version,
        });
        // The builtin path never touches the tenant firm rows.
        expect(h.list).not.toHaveBeenCalled();
        expect(h.resolveProcedureReference).not.toHaveBeenCalled();
      },
    );
  });

  describe('eligible firm procedures', () => {
    it('offers an enabled, runnable row with its exact version and digest', () => {
      const result = catalog([firmRow()]);
      expect(result.counts).toEqual({ builtin: 6, firm: 1, total: 7 });
      const entry = result.entries.at(-1)!;
      expect(entry.selector).toEqual({
        source: 'firm',
        recordId: 'row-1',
        version: 3,
        manifestDigest: firmDigest,
      });
      expect(entry.display).toEqual({
        id: 'row-1',
        canonicalId: 'commitments_audit',
        label: 'Commitments & Deliverables',
        purpose: firmManifest.purpose,
        scopes: ['general', 'client'],
      });
      expect(parseSelectedProcedureSelector(entry.selector)).toEqual(entry.selector);
    });

    it('round-trips the firm selector through the real canonical resolver', async () => {
      const entry = catalog([firmRow()]).entries.at(-1)!;
      const h = ownerDouble([firmRow()]);
      const admission = await resolveSelectedProcedureAdmission({
        ctx,
        clientId: CLIENT,
        selector: entry.selector,
        firmSkills: h.firmSkills as never,
        now: 3_000,
      });
      expect(admission.manifestDigest).toBe(firmDigest);
      expect(admission.identity).toEqual({
        source: 'firm',
        id: 'row-1',
        canonicalId: 'commitments_audit',
        version: 3,
      });
      expect(h.resolveProcedureReference).toHaveBeenCalledWith(TENANT, {
        source: 'firm',
        recordId: 'row-1',
        canonicalId: 'commitments_audit',
        version: 3,
      });
    });

    it.each([
      ['the row is disabled', () => [firmRow({ enabled: false, runnable: false })]],
      ['the row is not runnable (malformed stored payload)', () => [firmRow({ runnable: false })]],
      [
        'the row carries no procedure manifest',
        () => [firmRow({ procedureDigest: null, procedureScopes: [] })],
      ],
      ['the row is deleted or foreign to the tenant', () => []],
      [
        'the row identity cannot form a valid selector',
        () => [firmRow({ id: 'row.1' })],
      ],
    ])('cannot be chosen when %s', async (_label, rowsOf) => {
      const rows = (rowsOf as () => MeriFirmProcedureCatalogRow[])();
      // Hidden from the catalog...
      expect(catalog(rows).counts.firm).toBe(0);
      // ...and refused by the resolver even if a stale selector is replayed.
      const h = ownerDouble(rows as MeriFirmProcedureCatalogRow[]);
      await expect(
        resolveSelectedProcedureAdmission({
          ctx,
          clientId: CLIENT,
          selector: { source: 'firm', recordId: 'row-1', version: 3, manifestDigest: firmDigest },
          firmSkills: h.firmSkills as never,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a selector taken from a snapshot once the owner retires the row', async () => {
      const entry = catalog([firmRow()]).entries.at(-1)!;
      const h = ownerDouble([firmRow({ enabled: false, runnable: false })]);
      await expect(
        resolveSelectedProcedureAdmission({
          ctx,
          clientId: CLIENT,
          selector: entry.selector,
          firmSkills: h.firmSkills as never,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
      ['the version has advanced', () => [firmRow({ version: 4 })]],
      ['the digest has changed', () => [firmRow({ procedureDigest: 'c'.repeat(64) })]],
    ])('a catalog selector is refused after %s', async (_label, rowsOf) => {
      const entry = catalog([firmRow()]).entries.at(-1)!;
      const h = ownerDouble((rowsOf as () => MeriFirmProcedureCatalogRow[])());
      await expect(
        resolveSelectedProcedureAdmission({
          ctx,
          clientId: CLIENT,
          selector: entry.selector,
          firmSkills: h.firmSkills as never,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is deterministic for a given tenant, row set and time', () => {
      expect(catalog([firmRow()])).toEqual(catalog([firmRow()]));
    });
  });

  describe('current authority retirement through the real admission service', () => {
    function admissionHarness(conversation: { id: string; clientId: string | null } | null = {
      id: CONVERSATION,
      clientId: null,
    }) {
      let current = conversation;
      let wallAllowed = true;
      const revisions = { identityRevision: 'i1', membershipRevision: 'm1', contextRevision: 'c1' };
      const findFirst = jest.fn(async () => current);
      const wallLookup = jest.fn(async () =>
        wallAllowed ? [{ allowed: true }] : [{ allowed: false }],
      );
      const prisma = {
        withTenantUser: jest.fn(
          async (_tenantId: string, _userId: string, run: (tx: unknown) => unknown) =>
            run({ clioConversation: { findFirst }, $queryRawUnsafe: wallLookup }),
        ),
      };
      const applicationCurrent = { read: jest.fn(async () => ({ ...revisions })) };
      const service = new MeriProcedureRuntimeValidationService(
        prisma as never,
        ownerDouble([]).firmSkills as never,
        applicationCurrent as never,
      );
      return {
        service,
        findFirst,
        applicationCurrent,
        setConversation(next: typeof conversation) {
          current = next;
        },
        setWallAllowed(next: boolean) {
          wallAllowed = next;
        },
      };
    }

    const briefing = catalog().entries[0]!.selector;
    const input = {
      conversationId: CONVERSATION,
      clientId: null,
      scope: 'general' as const,
      selector: briefing,
    };

    it('admits a catalog builtin selector against the real current-account owner', async () => {
      const h = admissionHarness();
      const admission = await h.service.admitSelectedProcedure(ctx, {} as Request, input);
      expect(admission.manifestDigest).toBe(builtinProcedureDigest('briefing'));
      expect(admission.tenantId).toBe(TENANT);
      // Identity traced before and after the async canonical resolution.
      expect(h.applicationCurrent.read).toHaveBeenCalledTimes(2);
    });

    it('refuses when the conversation is retired', async () => {
      const h = admissionHarness({ id: CONVERSATION, clientId: null });
      h.setConversation(null);
      await expect(
        h.service.admitSelectedProcedure(ctx, {} as Request, input),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses when ethical-wall authority is revoked', async () => {
      const h = admissionHarness({ id: CONVERSATION, clientId: CLIENT });
      h.setWallAllowed(false);
      await expect(
        h.service.admitSelectedProcedure(ctx, {} as Request, {
          ...input,
          clientId: CLIENT,
          scope: 'client',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses when current identity/membership/context drift during resolution', async () => {
      const h = admissionHarness();
      h.applicationCurrent.read
        .mockResolvedValueOnce({
          identityRevision: 'i1',
          membershipRevision: 'm1',
          contextRevision: 'c1',
        })
        .mockResolvedValueOnce({
          identityRevision: 'i1',
          membershipRevision: 'm1',
          contextRevision: 'c2',
        });
      await expect(
        h.service.admitSelectedProcedure(ctx, {} as Request, input),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('standard read vs admin mutation', () => {
    function controllerWith(firmSkills: unknown) {
      return new MeriController(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        firmSkills as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }

    it('projects the catalog through the actual controller route for the current tenant', async () => {
      const list = jest.fn(async () => [firmRow()]);
      const controller = controllerWith({ list });
      const result = await controller.procedureCatalog(ctx);
      expect(list).toHaveBeenCalledWith(ctx);
      expect(result.tenantId).toBe(TENANT);
      expect(result.counts).toEqual({ builtin: 6, firm: 1, total: 7 });
    });

    it('keeps browse at standard_user while governance mutations stay user_admin', () => {
      expect(Reflect.getMetadata(ROLES_KEY, MeriController)).toEqual(['standard_user']);
      expect(Reflect.getMetadata(ROLES_KEY, MeriController.prototype.procedureCatalog)).toEqual([
        'standard_user',
      ]);
      const proto = MeriController.prototype as unknown as Record<string, object>;
      for (const mutation of [
        'listFirmSkills',
        'createFirmSkill',
        'updateFirmSkill',
        'setFirmSkillEnabled',
        'deleteFirmSkill',
        'restoreFirmSkill',
        'testFirmSkill',
      ]) {
        expect(Reflect.getMetadata(ROLES_KEY, proto[mutation]!)).toEqual(['user_admin']);
      }
      // Browse is strictly below mutation.
      expect(ROLE_RANK.standard_user).toBeLessThan(ROLE_RANK.user_admin);
    });
  });
});
