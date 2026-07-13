import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsOptional, IsString, Length } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MemoryCandidateService } from './memory-candidate.service.js';

class PromoteMemoryCandidateDto {
  @IsString() @Length(1, 128) tenantId!: string;
  /** The verified Clerk user id of the promoter — resolved to a Capiro user here. */
  @IsString() @Length(1, 128) clerkUserId!: string;
  @IsString() @Length(1, 200) key!: string;
  @IsString() @Length(1, 8000) value!: string;
  @IsOptional() @IsString() @Length(1, 64) source?: string;
}

/**
 * Internal-only memory write-back (Phase 3.4). Lets a BACKEND service (currently
 * apps/workspace, when a user promotes an approved artifact's facts) create a
 * memory_candidate through Phase 1's REAL candidate lifecycle — never a raw
 * insert — so the firm-review governance holds no matter which service proposes.
 *
 * Gated by InternalServiceGuard (x-internal-service-secret, fail-closed): never
 * reachable by a browser JWT, same channel as BYOK3 + internal onboarding. Lives
 * under /api/internal, which the tenant-context middleware excludes by design,
 * so tenantId + clerkUserId travel in the body (verified by the calling service).
 */
@Controller('internal/memory')
@UseGuards(InternalServiceGuard)
export class InternalMemoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly candidates: MemoryCandidateService,
  ) {}

  @Post('candidates')
  @HttpCode(200)
  async createCandidate(@Body() body: PromoteMemoryCandidateDto) {
    // Resolve the Capiro user from the globally-unique clerk id (a backend
    // service carries only the verified Clerk claim, never a Capiro user id —
    // mirrors MeriContextResolver). Fail closed if there is no matching user:
    // never synthesize an id for an audit-bearing memory write.
    const user = await this.prisma.user.findUnique({
      where: { clerkUserId: body.clerkUserId },
      select: { id: true },
    });
    if (!user) throw new BadRequestException('No Capiro user for the supplied identity');

    // Workspace promotions are FIRM-scope institutional memory. isAdmin=false so
    // the candidate is ALWAYS 'pending' (never auto-committed) — it lands in the
    // existing admin review queue (GET /memory/candidates), tagged
    // 'artifact_approval' (the 1B CHECK constraint's canonical source class for
    // artifact-driven proposals; the record's `source` field carries the finer
    // 'workspace' origin). Artifact approval and memory promotion stay separate
    // decisions (blueprint §6.4).
    const result = await this.candidates.proposeSaveMemory(
      body.tenantId,
      user.id,
      {
        scope: 'firm',
        ownerUserId: null,
        key: body.key,
        value: body.value,
        source: body.source ?? 'workspace',
      },
      false,
      'artifact_approval',
    );
    return { candidateId: result.candidateId, status: result.status };
  }
}
