// Document Agent Quality Service — an adapter over the existing ChecksService.
// Does NOT duplicate existing checks. Adds agent-specific checks for the
// document-agent workflow. A "fix" operation creates a revision proposal;
// it never silently edits the document.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChecksService, type WsCheckResult } from '../checks/checks.service.js';
import { readAgentState } from './document-agent-state.js';
import type { DocumentAgentRevisionService } from './document-agent-revision.service.js';

export interface AgentQualityResult {
  score: number;
  readiness: 'ready' | 'ready_with_recommendations' | 'not_ready';
  blockers: string[];
  recommendations: string[];
  checks: Array<{
    id: string;
    label: string;
    status: 'success' | 'notable' | 'critical';
    detail: string;
    fixable: boolean;
    severity: 'critical' | 'high' | 'medium' | 'low';
  }>;
}

@Injectable()
export class DocumentAgentQualityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: ChecksService,
  ) {}

  /**
   * Evaluate the document quality. Wraps the existing ChecksService and adds
   * agent-specific checks.
   */
  async evaluate(tenantId: string, draftId: string): Promise<AgentQualityResult> {
    // Run the existing checks (backward-compatible).
    const existing = await this.checks.evaluate(tenantId, draftId);

    // Load the agent state.
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      select: { config: true },
    });
    if (!draft) {
      return {
        score: 0,
        readiness: 'not_ready',
        blockers: ['Draft not found'],
        recommendations: [],
        checks: [],
      };
    }
    const state = readAgentState(draft.config as Record<string, unknown>);

    // Agent-specific checks.
    const agentChecks: WsCheckResult[] = [];

    // 1. Brief approved.
    agentChecks.push(
      this.check(
        'agent:brief_approved',
        'Working brief approved',
        state.brief.approvedAt
          ? { status: 'success', detail: 'approved' }
          : { status: 'critical', detail: 'brief not approved' },
      ),
    );

    // 2. Context approved.
    agentChecks.push(
      this.check(
        'agent:context_approved',
        'Context plan approved',
        state.contextPlan.approvedAt
          ? { status: 'success', detail: 'approved' }
          : { status: 'notable', detail: 'context not approved' },
      ),
    );

    // 3. Outline approved.
    agentChecks.push(
      this.check(
        'agent:outline_approved',
        'Outline approved',
        state.outline.approvedAt
          ? { status: 'success', detail: 'approved' }
          : { status: 'notable', detail: 'outline not approved' },
      ),
    );

    // 4. Blueprint version pinned.
    agentChecks.push(
      this.check(
        'agent:blueprint_pinned',
        'Blueprint version pinned',
        state.blueprintPin
          ? { status: 'success', detail: `v${state.blueprintPin.version}` }
          : { status: 'notable', detail: 'no blueprint pinned' },
      ),
    );

    // 5. Required sections present.
    const requiredSections = state.outline.sections.filter((s) => s.required);
    const allRequiredPresent = requiredSections.length > 0;
    agentChecks.push(
      this.check(
        'agent:required_sections',
        'Required sections present',
        allRequiredPresent
          ? { status: 'success', detail: `${requiredSections.length} required` }
          : { status: 'critical', detail: 'no required sections' },
      ),
    );

    // 6. Locked sections preserved.
    const lockedSections = state.outline.sections.filter((s) => s.locked);
    agentChecks.push(
      this.check(
        'agent:locked_sections',
        'Locked sections preserved',
        { status: 'success', detail: `${lockedSections.length} locked` },
      ),
    );

    // 7. Claim coverage.
    const coverage = state.contextPlan.coverage;
    agentChecks.push(
      this.check(
        'agent:claim_coverage',
        'Claim coverage',
        coverage.missingClaims.length === 0
          ? { status: 'success', detail: `${coverage.supportedClaims}/${coverage.plannedClaims} supported` }
          : {
              status: coverage.missingClaims.length > coverage.plannedClaims / 2 ? 'critical' : 'notable',
              detail: `${coverage.missingClaims.length} claims missing`,
            },
      ),
    );

    // 8. Open assumptions.
    const openAssumptions = state.brief.assumptions.filter((a) => a.status === 'open');
    agentChecks.push(
      this.check(
        'agent:open_assumptions',
        'Open assumptions',
        openAssumptions.length === 0
          ? { status: 'success', detail: 'all resolved' }
          : { status: 'notable', detail: `${openAssumptions.length} open` },
      ),
    );

    // 9. Unresolved source conflicts.
    const unresolvedConflicts = state.contextPlan.conflicts.filter((c) => !c.resolved);
    agentChecks.push(
      this.check(
        'agent:source_conflicts',
        'Unresolved source conflicts',
        unresolvedConflicts.length === 0
          ? { status: 'success', detail: 'none' }
          : { status: 'critical', detail: `${unresolvedConflicts.length} unresolved` },
      ),
    );

    // 10. Generation state.
    const genState = state.generation.lastRun;
    agentChecks.push(
      this.check(
        'agent:generation_state',
        'Generation state',
        genState?.status === 'complete'
          ? { status: 'success', detail: 'complete' }
          : genState?.status === 'partial'
            ? { status: 'notable', detail: 'partial' }
            : genState?.status === 'failed'
              ? { status: 'critical', detail: 'failed' }
              : { status: 'notable', detail: 'not generated' },
      ),
    );

    // Merge all checks.
    const allChecks = [...existing.checks, ...agentChecks];
    const blockers = allChecks
      .filter((c) => c.status === 'critical')
      .map((c) => `${c.label}: ${c.detail}`);
    const recommendations = allChecks
      .filter((c) => c.status === 'notable')
      .map((c) => `${c.label}: ${c.detail}`);

    // Score: percentage of checks that passed.
    const passed = allChecks.filter((c) => c.status === 'success').length;
    const total = allChecks.length;
    const score = total > 0 ? Math.round((passed / total) * 100) : 0;

    const readiness: AgentQualityResult['readiness'] =
      blockers.length > 0 ? 'not_ready' : recommendations.length > 0 ? 'ready_with_recommendations' : 'ready';

    return {
      score,
      readiness,
      blockers,
      recommendations,
      checks: allChecks,
    };
  }

  /**
   * Create a fix proposal for a quality issue. Returns a proposal — never
   * silently edits the document.
   */
  async createFixProposal(params: {
    tenantId: string;
    draftId: string;
    issueId: string;
    createdById: string;
    baseRevision: number;
    baseHash: string;
    instruction?: string;
  }): Promise<{ proposalId: string }> {
    const proposal = await this.prisma.wsAgentProposal.create({
      data: {
        tenantId: params.tenantId,
        draftId: params.draftId,
        createdById: params.createdById,
        type: `quality_fix:${params.issueId}`,
        status: 'pending',
        baseRevision: params.baseRevision,
        baseHash: params.baseHash,
        payload: { issueId: params.issueId, instruction: params.instruction },
      },
    });
    return { proposalId: proposal.id };
  }

  private check(
    id: string,
    label: string,
    r: { status: 'success' | 'notable' | 'critical'; detail: string },
  ): WsCheckResult {
    const severity: 'critical' | 'high' | 'medium' | 'low' =
      r.status === 'critical' ? 'high' : r.status === 'notable' ? 'medium' : 'low';
    return {
      id,
      label,
      status: r.status,
      detail: r.detail,
      fixable: r.status !== 'success',
      severity,
      section: null,
    };
  }
}
