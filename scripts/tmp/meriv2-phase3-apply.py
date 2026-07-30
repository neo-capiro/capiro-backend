from pathlib import Path


def replace(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))


# Candidate contract: carry the exact Settings file identity and complete section state.
path = "apps/api/src/memory/memory-candidate.service.ts"
replace(
    path,
    "import type { AppConfig } from '../config/config.schema.js';\n",
    "import type { AppConfig } from '../config/config.schema.js';\nimport type { MemoryItemType, MemorySection } from './memory.types.js';\n",
)
replace(
    path,
    "  sourceExcerpt?: string | null;\n}\n",
    "  sourceExcerpt?: string | null;\n  /** Exact canonical file identity for Settings-originated complete-section proposals. */\n  canonicalItem?: {\n    type: MemoryItemType;\n    slug: string;\n    title: string;\n    sections: MemorySection[];\n  };\n}\n",
)
replace(
    path,
    "type CandidateActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;\n",
    "type CandidateActorContext = Pick<TenantContext, 'tenantId' | 'userId' | 'role'>;\n\nexport interface SettingsMemoryCandidateInput {\n  type: MemoryItemType;\n  slug: string;\n  title: string;\n  scope: 'firm' | 'client';\n  clientId: string | null;\n  sections: MemorySection[];\n}\n\nexport interface PendingSettingsCandidate {\n  candidateId: string;\n  status: 'pending_review';\n  submittedAt: string;\n}\n",
)
replace(
    path,
    "  /** Entry point for MeriToolsService.saveMemory. Always creates a candidate;\n",
    "  /** Submit a complete Settings firm/client file for independent review. */\n  async proposeSettingsSections(\n    ctx: CandidateActorContext,\n    input: SettingsMemoryCandidateInput,\n  ): Promise<PendingSettingsCandidate> {\n    const record: MemorySaveRequest = {\n      scope: input.scope === 'client' ? 'client' : 'firm',\n      ownerUserId: null,\n      clientId: input.scope === 'client' ? input.clientId : null,\n      key: `settings-file:${input.type}:${input.slug}`,\n      value: JSON.stringify(input.sections),\n      source: 'settings_memory_editor',\n      canonicalItem: {\n        type: input.type,\n        slug: input.slug,\n        title: input.title,\n        sections: input.sections,\n      },\n    };\n    const result = await this.proposeSaveMemory(\n      ctx.tenantId,\n      ctx.userId,\n      record,\n      ctx.role === 'user_admin' || ctx.role === 'capiro_admin',\n      'settings_sections',\n    );\n    if (result.status !== 'pending') {\n      throw new Error('Shared Settings memory unexpectedly bypassed independent review.');\n    }\n    return {\n      candidateId: result.candidateId,\n      status: 'pending_review',\n      submittedAt: new Date().toISOString(),\n    };\n  }\n\n  /** Return the newest pending proposal for this exact Settings file. */\n  async findPendingSettingsCandidate(\n    tenantId: string,\n    viewerUserId: string,\n    type: MemoryItemType,\n    slug: string,\n  ): Promise<PendingSettingsCandidate | null> {\n    return this.prisma.withTenantUser(tenantId, viewerUserId, async (tx) => {\n      const rows = await tx.$queryRaw<Array<{ id: string; created_at: Date }>>`\n        SELECT id::text AS id, created_at\n        FROM memory_candidate\n        WHERE tenant_id = ${tenantId}::uuid\n          AND status = 'pending'\n          AND source_kind = 'settings_sections'\n          AND payload_jsonb #>> '{canonicalItem,type}' = ${type}\n          AND payload_jsonb #>> '{canonicalItem,slug}' = ${slug}\n        ORDER BY created_at DESC\n        LIMIT 1\n      `;\n      const row = rows[0];\n      return row\n        ? { candidateId: row.id, status: 'pending_review', submittedAt: row.created_at.toISOString() }\n        : null;\n    });\n  }\n\n  /** Entry point for MeriToolsService.saveMemory. Always creates a candidate;\n",
)
replace(
    path,
    "      sourceExcerpt,\n    };\n",
    "      sourceExcerpt,\n      canonicalItem: record.canonicalItem ?? null,\n    };\n",
)
replace(
    path,
    "    sourceExcerpt?: unknown;\n  };\n",
    "    sourceExcerpt?: unknown;\n    canonicalItem?: unknown;\n  };\n",
)
replace(
    path,
    "    sourceExcerpt: typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.slice(0, 4_000) : null,\n  };\n}\n",
    "    sourceExcerpt: typeof raw.sourceExcerpt === 'string' ? raw.sourceExcerpt.slice(0, 4_000) : null,\n    canonicalItem: parseCanonicalItem(raw.canonicalItem),\n  };\n}\n\nfunction parseCanonicalItem(value: unknown): MemorySaveRequest['canonicalItem'] {\n  if (value == null) return undefined;\n  const item = value as { type?: unknown; slug?: unknown; title?: unknown; sections?: unknown };\n  if (\n    typeof item.type !== 'string' ||\n    typeof item.slug !== 'string' ||\n    typeof item.title !== 'string' ||\n    !Array.isArray(item.sections)\n  ) {\n    throw new BadRequestException('Malformed Settings memory candidate payload.');\n  }\n  const sections = item.sections.map((raw) => {\n    const section = raw as { key?: unknown; heading?: unknown; owner?: unknown; body?: unknown };\n    if (\n      typeof section.key !== 'string' ||\n      typeof section.heading !== 'string' ||\n      (section.owner !== 'human' && section.owner !== 'engine') ||\n      typeof section.body !== 'string'\n    ) {\n      throw new BadRequestException('Malformed Settings memory candidate sections.');\n    }\n    return {\n      key: section.key,\n      heading: section.heading,\n      owner: section.owner,\n      body: section.body,\n    } satisfies MemorySection;\n  });\n  return {\n    type: item.type as MemoryItemType,\n    slug: item.slug,\n    title: item.title,\n    sections,\n  };\n}\n",
)

# Canonical activation: approved Settings proposals update the exact file, not a generic projection row.
path = "apps/api/src/memory/memory-canonical-activation.helpers.ts"
replace(
    path,
    "  sourceExcerpt?: string | null;\n}\n",
    "  sourceExcerpt?: string | null;\n  canonicalItem?: {\n    type: string;\n    slug: string;\n    title: string;\n    sections: Array<{ key: string; heading: string; owner: 'human' | 'engine'; body: string }>;\n  };\n}\n",
)
replace(
    path,
    "    sourceKind === 'model_extraction'\n      ? 'steward_extraction'\n      : sourceKind === 'explicit_user'\n        ? 'user_message'\n        : 'unknown';\n",
    "    sourceKind === 'model_extraction'\n      ? 'steward_extraction'\n      : sourceKind === 'explicit_user'\n        ? 'user_message'\n        : sourceKind === 'settings_sections'\n          ? 'settings_editor'\n          : 'unknown';\n",
)
replace(
    path,
    "  const sections = JSON.stringify([\n    { key: 'memory', heading: 'Memory', owner: 'human', body: record.value.trim() },\n  ]);\n",
    "  const canonicalItem = record.canonicalItem;\n  const canonicalType = canonicalItem?.type ?? governance.canonicalType;\n  const canonicalSlug = canonicalItem?.slug ?? clioMemorySlug(clioMemoryId);\n  const canonicalTitle = canonicalItem?.title ?? record.key;\n  const canonicalSections = canonicalItem?.sections ?? [\n    { key: 'memory', heading: 'Memory', owner: 'human' as const, body: record.value.trim() },\n  ];\n  const sections = JSON.stringify(canonicalSections);\n",
)
replace(path, "       ${governance.canonicalType}, ${visibility}, NULL,\n", "       ${canonicalType}, ${visibility}, NULL,\n")
replace(
    path,
    "       ${clioMemorySlug(clioMemoryId)}, ${record.key}, ARRAY[]::text[],\n       ARRAY['memory', ${record.source}], 'manual', ${governance.sourceRef}, 'human',\n",
    "       ${canonicalSlug}, ${canonicalTitle}, ARRAY[]::text[],\n       ARRAY['memory-file', ${record.scope}], 'manual', ${governance.sourceRef}, 'human',\n",
)

# Controller: user files save directly; shared files only create complete-state candidates.
path = "apps/api/src/memory/memory.controller.ts"
replace(
    path,
    "  skeletonSections,\n} from './memory-catalog.js';\n",
    "  skeletonSections,\n  mergeEditedSections,\n} from './memory-catalog.js';\n",
)
replace(
    path,
    "    const effectiveSlug = def?.scope === 'user' ? ctx.userId : slug;\n    const item = await this.store.getByTypeSlug(type, effectiveSlug);\n",
    "    const effectiveSlug = def?.scope === 'user' ? ctx.userId : slug;\n    if (def?.scope === 'client' && !(await this.store.clientMemoryAllowedForCurrentUser(slug))) {\n      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');\n    }\n    const item = await this.store.getByTypeSlug(type, effectiveSlug);\n    const pendingReview =\n      def?.scope === 'firm' || def?.scope === 'client'\n        ? await this.candidates.findPendingSettingsCandidate(ctx.tenantId, ctx.userId, type, effectiveSlug)\n        : null;\n",
)
replace(
    path,
    "      exists: !!item,\n      sections: sections.map((s) => ({\n",
    "      exists: !!item,\n      pendingReview,\n      sections: sections.map((s) => ({\n",
)
old = """    // User files key on the caller's own id — ignore any slug spoof.\n    const effectiveSlug = scope === 'user' ? ctx.userId : slug;\n    const clientId = scope === 'client' ? slug : null;\n    // Ethical wall (fail-closed, binds admins too): a non-granted user must not\n    // WRITE a walled client's file. Without this, the wall hides the existing\n    // row from the read path, so upsertSections would rebuild it from the\n    // catalog skeleton and clobber the real content via the RLS-bypassing\n    // upsertSystem. 403 loudly rather than silently corrupt.\n    if (clientId && !(await this.store.clientMemoryAllowedForCurrentUser(clientId))) {\n      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');\n    }\n    // Governed-memory authority (Phase 3). The checks above cover role and the\n    // ethical wall; this adds what they do not — legal hold, terminal\n    // (revoked/superseded) status, explicit per-client edit grants, and the real\n    // actor role under impersonation. Only applied to an EXISTING item: this route\n    // also creates a file from the catalog skeleton on first save, and there is no\n    // subject to authorize yet in that case.\n    if (governedMemoryEnforcementEnabled(process.env.MEMORY_GOVERNANCE_ENFORCE)) {\n      const existing = await this.store.getByTypeSlug(type, effectiveSlug);\n      if (existing) await this.authz.requireItem(ctx, existing.id, 'edit');\n    }\n    const updated = await this.store.upsertSectionsForCurrentTenant(\n      type,\n      effectiveSlug,\n      scope,\n      clientId,\n      body?.sections ?? [],\n      editableSectionKeys(type),\n    );\n    return { ok: true, updatedAt: updated.updatedAt };\n"""
new = """    // User files key on the caller's own id — ignore any slug spoof.\n    const effectiveSlug = scope === 'user' ? ctx.userId : slug;\n    const clientId = scope === 'client' ? slug : null;\n    if (clientId && !(await this.store.clientMemoryAllowedForCurrentUser(clientId))) {\n      throw new ForbiddenException('This client is behind an ethical wall you are not granted.');\n    }\n\n    const existing = await this.store.getByTypeSlug(type, effectiveSlug);\n    if (governedMemoryEnforcementEnabled(process.env.MEMORY_GOVERNANCE_ENFORCE) && existing) {\n      await this.authz.requireItem(ctx, existing.id, 'edit');\n    }\n\n    if (scope === 'firm' || scope === 'client') {\n      const sections = mergeEditedSections(\n        type,\n        existing?.sections ?? null,\n        body?.sections ?? [],\n        editableSectionKeys(type),\n      );\n      const pending = await this.candidates.proposeSettingsSections(ctx, {\n        type,\n        slug: effectiveSlug,\n        title: existing?.title ?? def.label,\n        scope,\n        clientId,\n        sections,\n      });\n      return {\n        status: 'pending_review' as const,\n        candidateId: pending.candidateId,\n        activeItemUnchanged: true as const,\n      };\n    }\n\n    const updated = await this.store.upsertSectionsForCurrentTenant(\n      type,\n      effectiveSlug,\n      scope,\n      clientId,\n      body?.sections ?? [],\n      editableSectionKeys(type),\n    );\n    return { ok: true as const, updatedAt: updated.updatedAt };\n"""
replace(path, old, new)

# UI: truthful pending-review feedback and persistent reload state.
path = "apps/web/src/components/MemoryFileEditor.tsx"
replace(
    path,
    "interface ItemSectionsResp {\n  type: string; slug: string; title: string; visibility: string;\n  clientId: string | null; updatedAt: string; sections: ItemSection[];\n}\n",
    "interface PendingReviewState { candidateId: string; status: 'pending_review'; submittedAt: string }\ninterface ItemSectionsResp {\n  type: string; slug: string; title: string; visibility: string;\n  clientId: string | null; updatedAt: string | null; pendingReview: PendingReviewState | null;\n  sections: ItemSection[];\n}\ninterface SaveSectionsResp {\n  ok?: true;\n  updatedAt?: string;\n  status?: 'pending_review';\n  candidateId?: string;\n  activeItemUnchanged?: true;\n}\n\nexport function settingsMemorySuccessMessage(result: SaveSectionsResp): string {\n  return result.status === 'pending_review'\n    ? 'Submitted for independent review'\n    : 'Saved';\n}\n",
)
replace(
    path,
    "    mutationFn: async (sections: { key: string; body: string }[]) =>\n      (await api.put(`/api/memory/items/${fileType}/${slug}/sections`, { sections })).data,\n    onSuccess: () => {\n      message.success('Saved');\n",
    "    mutationFn: async (sections: { key: string; body: string }[]) =>\n      (await api.put<SaveSectionsResp>(`/api/memory/items/${fileType}/${slug}/sections`, { sections })).data,\n    onSuccess: (result) => {\n      message.success(settingsMemorySuccessMessage(result));\n",
)
replace(
    path,
    "  const canSave = canEdit && !!itemQuery.data && !saveMutation.isPending;\n",
    "  const sharedPending = scope !== 'user' && !!itemQuery.data?.pendingReview;\n  const canSave = canEdit && !!itemQuery.data && !saveMutation.isPending && !sharedPending;\n",
)
replace(
    path,
    "      Save changes\n",
    "      {scope === 'user' ? 'Save changes' : 'Submit for review'}\n",
)
replace(
    path,
    "      {!canEdit && (\n        <Alert type=\"info\" showIcon message=\"You can view this file. Editing requires an admin role.\" />\n      )}\n\n      {ready && itemQuery.isLoading && <Spin />}\n",
    "      {!canEdit && (\n        <Alert type=\"info\" showIcon message=\"You can view this file. Editing requires an admin role.\" />\n      )}\n      {itemQuery.data?.pendingReview && (\n        <Alert\n          type=\"success\"\n          showIcon\n          message=\"Submitted for independent review\"\n          description={`Candidate ${itemQuery.data.pendingReview.candidateId}. Active content remains unchanged until approval.`}\n        />\n      )}\n\n      {ready && itemQuery.isLoading && <Spin />}\n",
)

# Focused API tests for the live Settings route.
Path("apps/api/src/memory/memory.controller.settings-review.spec.ts").write_text("""import { describe, expect, it, jest } from '@jest/globals';
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { MemoryController } from './memory.controller.js';
import type { MemoryStoreService } from './memory-store.service.js';
import type { MemoryCandidateService } from './memory-candidate.service.js';
import type { MemoryAuthorizationService } from './memory-authorization.service.js';

const ctx: TenantContext = {
  tenantId: '11111111-1111-4111-8111-111111111111', tenantSlug: 'test',
  userId: '22222222-2222-4222-8222-222222222222', clerkUserId: 'admin', role: 'user_admin',
};
const CLIENT = '33333333-3333-4333-8333-333333333333';
const sections = [{ key: 'mission', body: 'Protect the active truth.' }];

function harness(opts: { existing?: any; wallAllowed?: boolean; pending?: any } = {}) {
  const getByTypeSlug = jest.fn(async () => opts.existing ?? null);
  const upsertSectionsForCurrentTenant = jest.fn(async () => ({ updatedAt: '2026-07-30T00:00:00.000Z' }));
  const clientMemoryAllowedForCurrentUser = jest.fn(async () => opts.wallAllowed ?? true);
  const proposeSettingsSections = jest.fn(async () => ({
    candidateId: '44444444-4444-4444-8444-444444444444', status: 'pending_review',
    submittedAt: '2026-07-30T00:00:00.000Z',
  }));
  const findPendingSettingsCandidate = jest.fn(async () => opts.pending ?? null);
  const requireItem = jest.fn(async () => undefined);
  const store = { getByTypeSlug, upsertSectionsForCurrentTenant, clientMemoryAllowedForCurrentUser };
  const candidates = { proposeSettingsSections, findPendingSettingsCandidate };
  const controller = new MemoryController(
    store as unknown as MemoryStoreService, {} as any, {} as any, {} as any,
    candidates as unknown as MemoryCandidateService, {} as any,
    { requireItem } as unknown as MemoryAuthorizationService, {} as any, {} as any,
    { get: jest.fn(() => undefined) } as unknown as ConfigService<AppConfig, true>,
  );
  return { controller, getByTypeSlug, upsertSectionsForCurrentTenant, clientMemoryAllowedForCurrentUser, proposeSettingsSections, findPendingSettingsCandidate };
}

describe('Settings shared-memory review lifecycle', () => {
  it('creates a firm candidate and leaves the active item unchanged', async () => {
    const active = { id: 'item-1', title: 'Firm Soul', sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Current' }] };
    const h = harness({ existing: active });
    await expect(h.controller.updateSections(ctx, 'firm-soul', 'firm', { sections })).resolves.toEqual({
      status: 'pending_review', candidateId: '44444444-4444-4444-8444-444444444444', activeItemUnchanged: true,
    });
    expect(h.proposeSettingsSections).toHaveBeenCalledWith(ctx, expect.objectContaining({ type: 'firm-soul', slug: 'firm', scope: 'firm' }));
    expect(h.upsertSectionsForCurrentTenant).not.toHaveBeenCalled();
    expect(active.sections[0].body).toBe('Current');
  });

  it('creates only a candidate for a first-time shared file', async () => {
    const h = harness();
    await h.controller.updateSections(ctx, 'firm-soul', 'firm', { sections });
    expect(h.proposeSettingsSections).toHaveBeenCalledTimes(1);
    expect(h.upsertSectionsForCurrentTenant).not.toHaveBeenCalled();
  });

  it('fails closed on a client ethical wall before creating a candidate', async () => {
    const h = harness({ wallAllowed: false });
    await expect(h.controller.updateSections(ctx, 'client-soul', CLIENT, { sections })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.proposeSettingsSections).not.toHaveBeenCalled();
  });

  it('keeps owner-only user files on the immediate save path', async () => {
    const userCtx = { ...ctx, role: 'standard_user' as const };
    const h = harness();
    await expect(h.controller.updateSections(userCtx, 'user-profile', 'spoofed', { sections })).resolves.toMatchObject({ ok: true });
    expect(h.upsertSectionsForCurrentTenant).toHaveBeenCalledWith('user-profile', userCtx.userId, 'user', null, sections, expect.any(Set));
    expect(h.proposeSettingsSections).not.toHaveBeenCalled();
  });

  it('returns pending state on reload without replacing active sections', async () => {
    const pending = { candidateId: 'cand-1', status: 'pending_review', submittedAt: '2026-07-30T00:00:00.000Z' };
    const active = { title: 'Firm Soul', visibility: 'tenant', clientId: null, updatedAt: 'now', sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Current' }] };
    const h = harness({ existing: active, pending });
    const result = await h.controller.itemSections(ctx, 'firm-soul', 'firm');
    expect(result.pendingReview).toEqual(pending);
    expect(result.sections[0]?.body).toBe('Current');
  });
});
""")

# Exact canonical identity test for approved Settings proposals.
p = Path("apps/api/src/memory/memory-canonical-activation.helpers.spec.ts")
text = p.read_text()
needle = "  it('preserves authoritative governance when rebuilding the Clio projection', () => {\n"
test = """  it('activates an approved Settings proposal into the exact canonical file identity', async () => {
    let params: unknown[] = [];
    const tx = {
      $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
        params = values;
        return [{ id: ITEM }];
      },
    } as unknown as Prisma.TransactionClient;
    const settingsRecord: CanonicalMemoryRecord = {
      ...record('firm'),
      key: 'settings-file:firm-soul:firm',
      value: JSON.stringify([{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Reviewed' }]),
      source: 'settings_memory_editor',
      canonicalItem: {
        type: 'firm-soul', slug: 'firm', title: 'Firm Soul',
        sections: [{ key: 'mission', heading: 'Mission', owner: 'human', body: 'Reviewed' }],
      },
    };
    const governance = buildCanonicalGovernance({
      record: settingsRecord, sourceKind: 'settings_sections', candidateId: CANDIDATE,
      assertedByUserId: PROPOSER, approvedByUserId: REVIEWER, decision: 'approved',
    });
    await upsertCanonicalMemoryItemInTx(tx, TENANT, CLIO, settingsRecord, governance);
    expect(params).toContain('firm-soul');
    expect(params).toContain('firm');
    expect(params).toContain('Firm Soul');
    expect(params).toContain('firm_approved');
    expect(params).toContain(expect.stringContaining('Reviewed'));
  });

"""
if needle not in text:
    raise SystemExit('canonical spec insertion point not found')
p.write_text(text.replace(needle, test + needle, 1))

# UI decision test without coupling to Ant Design rendering internals.
Path("apps/web/src/components/MemoryFileEditor.phase3.test.ts").write_text("""import { describe, expect, it } from 'vitest';
import { settingsMemorySuccessMessage } from './MemoryFileEditor.js';

describe('MemoryFileEditor Phase 3 result wording', () => {
  it('never labels a shared candidate submission as Saved', () => {
    expect(settingsMemorySuccessMessage({
      status: 'pending_review', candidateId: 'cand-1', activeItemUnchanged: true,
    })).toBe('Submitted for independent review');
  });

  it('keeps the immediate personal-save wording', () => {
    expect(settingsMemorySuccessMessage({ ok: true, updatedAt: 'now' })).toBe('Saved');
  });
});
""")

print('Phase 3 patch applied')
