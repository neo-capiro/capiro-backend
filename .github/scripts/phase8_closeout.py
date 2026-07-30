from pathlib import Path


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, text: str) -> None:
    Path(path).write_text(text)


def ensure_import(path: str, anchor: str, import_line: str, label: str) -> None:
    text = read(path)
    if import_line in text:
        return
    count = text.count(anchor)
    assert count == 1, (label, count)
    write(path, text.replace(anchor, anchor + "\n" + import_line, 1))


def patch_memo_boundaries() -> None:
    helper = "import { rethrowRequiredContextPersistence } from '../../context/context-required-persistence.js';"
    anchor = "import { ContextCompilerService } from '../../context/context-compiler.service.js';"
    old_catch = """    } catch (err) {
      this.logger.debug(`steering compile skipped: ${(err as Error).message}`);
    }"""
    new_catch = """    } catch (err) {
      rethrowRequiredContextPersistence(err);
      this.logger.debug('steering compile skipped (context_compile_failed)');
    }"""
    for filename in ("alert-memo.service.ts", "district-brief.service.ts"):
        path = f"apps/api/src/intelligence/alert-memo/{filename}"
        ensure_import(path, anchor, helper, f"{filename} import")
        text = read(path)
        if new_catch in text:
            continue
        count = text.count(old_catch)
        assert count == 1, (f"{filename} steering catch", count)
        write(path, text.replace(old_catch, new_catch, 1))


def patch_outreach_boundary() -> None:
    path = "apps/api/src/engagement/engagement.service.ts"
    ensure_import(
        path,
        "import { ContextCompilerService } from '../context/context-compiler.service.js';",
        "import { rethrowRequiredContextPersistence } from '../context/context-required-persistence.js';",
        "engagement import",
    )
    text = read(path)
    method_start = text.index("  private async loadUserVoiceBlock(")
    method_end = text.index("\n  async generateOutreachDraft(", method_start)
    segment = text[method_start:method_end]

    signature_old = """  private async loadUserVoiceBlock(
    ctx: TenantContext,
    clientId: string | null,
  ): Promise<string | null> {"""
    signature_new = """  private async loadUserVoiceBlock(
    ctx: TenantContext,
    clientId: string | null,
    requiredPersistenceBoundary = false,
  ): Promise<string | null> {"""
    if signature_new not in segment:
        count = segment.count(signature_old)
        assert count == 1, ("outreach helper signature", count)
        segment = segment.replace(signature_old, signature_new, 1)

    catch_old = """    } catch {
      return null;
    }"""
    catch_new = """    } catch (error) {
      if (requiredPersistenceBoundary) rethrowRequiredContextPersistence(error);
      return null;
    }"""
    if catch_new not in segment:
        count = segment.count(catch_old)
        assert count == 1, ("outreach helper catch", count)
        segment = segment.replace(catch_old, catch_new, 1)

    text = text[:method_start] + segment + text[method_end:]

    single_old = "const voiceBlock = await this.loadUserVoiceBlock(ctx, record.client?.id ?? null);"
    single_new = "const voiceBlock = await this.loadUserVoiceBlock(ctx, record.client?.id ?? null, true);"
    if single_new not in text:
        count = text.count(single_old)
        assert count == 1, ("single outreach boundary", count)
        text = text.replace(single_old, single_new, 1)

    batch_old = "const voiceBlock = await this.loadUserVoiceBlock(ctx, clientId ?? null).catch(() => null);"
    batch_new = "const voiceBlock = await this.loadUserVoiceBlock(ctx, clientId ?? null, true);"
    if batch_new not in text:
        count = text.count(batch_old)
        assert count == 1, ("batch outreach boundary", count)
        text = text.replace(batch_old, batch_new, 1)

    write(path, text)


def patch_research_boundary() -> None:
    path = "apps/api/src/meri/meri-research.service.ts"
    text = read(path)
    old_nest_import = (
        "import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';"
    )
    new_nest_import = (
        "import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';"
    )
    if new_nest_import not in text:
        count = text.count(old_nest_import)
        assert count == 1, ("research Nest import", count)
        text = text.replace(old_nest_import, new_nest_import, 1)

    reviews_import = "import { ReviewsService } from '../reviews/reviews.service.js';"
    context_import = "import { ContextCompilerService } from '../context/context-compiler.service.js';"
    boundary_import = "import { rethrowRequiredContextPersistence } from '../context/context-required-persistence.js';"
    if context_import not in text:
        count = text.count(reviews_import)
        assert count == 1, ("research compiler import", count)
        text = text.replace(
            reviews_import,
            reviews_import + "\n" + context_import + "\n" + boundary_import,
            1,
        )

    old_ctor = """    private readonly aiCredentials: AiCredentialResolverService,
    private readonly reviews: ReviewsService,
  ) {}"""
    new_ctor = """    private readonly aiCredentials: AiCredentialResolverService,
    private readonly reviews: ReviewsService,
    @Optional() private readonly contextCompiler?: ContextCompilerService,
  ) {}"""
    if new_ctor not in text:
        count = text.count(old_ctor)
        assert count == 1, ("research constructor", count)
        text = text.replace(old_ctor, new_ctor, 1)

    start = text.index("  private async clientContext(")
    end = text.index("\n  /** Single non-streaming Anthropic completion", start)
    method = r'''  private async clientContext(ctx: TenantContext, clientId: string | null): Promise<string | null> {
    const parts: string[] = [];
    if (clientId) {
      try {
        const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.client.findFirst({
            where: { id: clientId },
            select: { name: true, description: true, productDescription: true },
          }),
        );
        if (client) {
          parts.push(`Client: ${client.name}`);
          if (client.description) parts.push(`Description: ${client.description}`);
          if (client.productDescription) parts.push(`Product/service: ${client.productDescription}`);
        }
      } catch {
        this.logger.warn('Research client profile load skipped (client_profile_unavailable)');
      }
    }

    if (this.contextCompiler) {
      try {
        const packet = await this.contextCompiler.compile({
          tenantId: ctx.tenantId,
          effectiveTenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          userId: ctx.userId,
          clientId,
          surface: 'research',
          layers: [
            'firm-identity',
            'firm-playbook',
            'user-voice',
            'client-steering',
            'client-people',
          ],
          render: 'all',
          ref: { clientId },
        });
        for (const item of packet.rendered) {
          parts.push(`Institutional context (${item.type}):\n${item.body}`);
        }
      } catch (error) {
        rethrowRequiredContextPersistence(error);
        this.logger.warn('Research context compile skipped (context_compile_failed)');
      }
    }

    return parts.length ? parts.join('\n') : null;
  }
'''
    text = text[:start] + method + text[end:]
    write(path, text)


def patch_default_off_infrastructure() -> None:
    path = "infra/cdk/lib/compute-stack.ts"
    text = read(path)
    if "MERIV2_CONTEXT_PACKET_V2" in text:
        return
    replacements = [
        (
            "      MERIV2_ENABLED: 'true',\n      MERIV2_ORCHESTRATOR_URL: `https://${cfg.appHost}`,",
            "      MERIV2_ENABLED: 'true',\n      MERIV2_CONTEXT_PACKET_V2: 'off',\n      MERIV2_ORCHESTRATOR_URL: `https://${cfg.appHost}`,",
        ),
        (
            "      WEB_ORIGIN: `https://${cfg.appHost}`,\n    };\n\n    const workspaceTaskDef",
            "      WEB_ORIGIN: `https://${cfg.appHost}`,\n      MERIV2_CONTEXT_PACKET_V2: 'off',\n    };\n\n    const workspaceTaskDef",
        ),
        (
            "      WEB_ORIGIN: `https://${cfg.appHost}`,\n      // Phase-0 client-context delegation target",
            "      WEB_ORIGIN: `https://${cfg.appHost}`,\n      MERIV2_CONTEXT_PACKET_V2: 'off',\n      // Phase-0 client-context delegation target",
        ),
    ]
    for old, new in replacements:
        count = text.count(old)
        assert count == 1, ("default-off infrastructure", old[:48], count)
        text = text.replace(old, new, 1)
    write(path, text)


def patch_workspace_test() -> None:
    path = "apps/api/src/workspace-assistant/workspace-assistant.context-v2.spec.ts"
    text = read(path)
    text = text.replace(
        "policyVersion: 'context-policy-v2.0'",
        "policyVersion: 'context-policy-v2.1'",
    )
    old = """        layers: ['firm-identity', 'user-voice'],
      }),"""
    new = """        layers: ['firm-identity', 'firm-playbook', 'user-voice'],
        allowedSensitivities: ['normal'],
      }),"""
    if new not in text:
        count = text.count(old)
        assert count == 1, ("workspace Phase 8 expectation", count)
        text = text.replace(old, new, 1)
    write(path, text)


def patch_orchestrator_test() -> None:
    path = "apps/meriv2-orchestrator/src/meri/context-compiler.service.spec.ts"
    text = read(path)
    canary = """
const CANARY = {
  clioFeatureFlags: {
    'meriv2.contextPacketV2': true,
    'meriv2.contextPacketV2.strategy': true,
  },
};
"""
    if "const CANARY =" not in text:
        anchor = "import type { PrismaService } from '../prisma/prisma.service';\n"
        count = text.count(anchor)
        assert count == 1, ("orchestrator canary anchor", count)
        text = text.replace(anchor, anchor + canary, 1)

    if "tenant: { findFirst:" not in text:
        anchor = "    const tx = {\n      $queryRaw:"
        count = text.count(anchor)
        assert count == 1, ("orchestrator tenant mock", count)
        text = text.replace(
            anchor,
            "    const tx = {\n      tenant: { findFirst: jest.fn().mockResolvedValue({ settings: CANARY }) },\n      $queryRaw:",
            1,
        )

    old = """  it('throws on a required persistence failure', async () => {
    const { prisma } = makePrisma([VOICE_ROW], { readBack: false });
    const service = new OrchestratorContextCompilerService(prisma);
    await expect(
      service.compile({
        tenantId: 't1',
        userId: 'u1',
        surface: 'strategy',
        layers: ['user-voice'],
        persistence: 'required',
      }),
    ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
  });"""
    new = """  it('throws on a required persistence failure once the server-owned canary is enforced', async () => {
    const original = process.env.MERIV2_CONTEXT_PACKET_V2;
    process.env.MERIV2_CONTEXT_PACKET_V2 = 'enforce';
    try {
      const { prisma } = makePrisma([VOICE_ROW], { readBack: false });
      const service = new OrchestratorContextCompilerService(prisma);
      await expect(
        service.compile({
          tenantId: 't1',
          userId: 'u1',
          surface: 'strategy',
          layers: ['user-voice'],
        }),
      ).rejects.toMatchObject({ name: 'ContextPacketPersistenceError' });
    } finally {
      if (original === undefined) delete process.env.MERIV2_CONTEXT_PACKET_V2;
      else process.env.MERIV2_CONTEXT_PACKET_V2 = original;
    }
  });"""
    if new not in text:
        count = text.count(old)
        assert count == 1, ("orchestrator required-persistence test", count)
        text = text.replace(old, new, 1)
    write(path, text)


def write_boundary_tests() -> None:
    write(
        "apps/api/src/context/context-required-persistence.spec.ts",
        """import { ContextPacketPersistenceError } from '@capiro/meriv2-core';
import { rethrowRequiredContextPersistence } from './context-required-persistence.js';

describe('rethrowRequiredContextPersistence', () => {
  it('rethrows the exact required-persistence error', () => {
    const error = new ContextPacketPersistenceError('context_packet_error', 'attempt-1', 'memo');
    expect(() => rethrowRequiredContextPersistence(error)).toThrow(error);
  });

  it('does not turn an optional compiler failure into a hold', () => {
    expect(() => rethrowRequiredContextPersistence(new Error('optional failure'))).not.toThrow();
  });
});
""",
    )
    write(
        "apps/api/src/context/context-rollout-live-paths.spec.ts",
        """import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(__dirname, '..');
const source = (path: string) => readFileSync(join(root, path), 'utf8');

describe('Phase 8 live external-deliverable boundaries', () => {
  it.each([
    ['memo', 'intelligence/alert-memo/alert-memo.service.ts'],
    ['district-brief', 'intelligence/alert-memo/district-brief.service.ts'],
    ['outreach', 'engagement/engagement.service.ts'],
    ['research', 'meri/meri-research.service.ts'],
  ])('%s uses the server compiler and preserves required persistence holds', (surface, path) => {
    const text = source(path);
    expect(text).toContain(`surface: '${surface}'`);
    expect(text).toContain('rethrowRequiredContextPersistence');
  });

  it('both outreach generation paths opt into the required-persistence boundary', () => {
    const text = source('engagement/engagement.service.ts');
    expect(text).toContain('loadUserVoiceBlock(ctx, record.client?.id ?? null, true)');
    expect(text).toContain('loadUserVoiceBlock(ctx, clientId ?? null, true)');
    expect(text).not.toContain('loadUserVoiceBlock(ctx, clientId ?? null).catch(() => null)');
  });
});
""",
    )


def patch_permanent_ci() -> None:
    path = ".github/workflows/memory-governance-ci.yml"
    text = read(path)
    if "src/context/context-required-persistence.spec.ts" in text:
        return
    anchor = "          src/context/context-compiler-v2.service.spec.ts\n"
    replacement = (
        anchor
        + "          src/context/context-required-persistence.spec.ts\n"
        + "          src/context/context-rollout-live-paths.spec.ts\n"
    )
    count = text.count(anchor)
    assert count == 1, ("permanent Phase 8 CI", count)
    write(path, text.replace(anchor, replacement, 1))


def main() -> None:
    patch_memo_boundaries()
    patch_outreach_boundary()
    patch_research_boundary()
    patch_default_off_infrastructure()
    patch_workspace_test()
    patch_orchestrator_test()
    write_boundary_tests()
    patch_permanent_ci()


if __name__ == "__main__":
    main()
