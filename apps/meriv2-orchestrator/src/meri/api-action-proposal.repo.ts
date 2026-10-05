import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestCredentialsStore } from '../request/request-credentials.store.js';
import type { ToolExecutionControl } from '@capiro/meriv2-core';
import { createMeriExecutionControl } from './meri-execution-control.js';
import { currentTrustedCurrentTurnScope } from '../request/trusted-current-turn-scope.js';
import { isCurrentConversationResearchPortfolioTool } from './current-turn-tool-scope.js';
import { buildResearchPortfolioProposalTransport } from './rp-action-proposal-transport.js';
import {
  emitMeriOrchestratorTelemetry,
  withMeriOrchestratorTelemetrySpan,
  meriOrchestratorTelemetryHeaders,
} from '../telemetry/meri-telemetry.runtime.js';
import { meriTelemetryOperationId } from '@capiro/meriv2-core';

export interface CreateActionProposalInput {
  tool: string;
  input: Record<string, unknown>;
  conversationId?: string;
  surface: 'chat';
}

export interface ActionProposalPolicy {
  source: string;
  mode: string;
  packKey: string;
  packVersion: string;
  binding: string;
  decisionHash: string;
  contextHash: string;
  decision: string;
  jurisdiction: string;
  channel: string;
  recipientType: string | null;
}

export interface ActionProposalResult {
  proposalId: string;
  status: string;
  tool: string;
  preview: {
    label: string;
    riskTier: string | null;
    leavesFirm: boolean;
    reversible: boolean;
    client?: { id: string; name?: string };
    fields: Record<string, string | number | boolean>;
    counts: Record<string, number>;
    reason: string;
  };
  expiresAt: string;
  reason: string;
  ruleId: string | null;
  riskTier: string | null;
  policyCode: string | null;
  attemptCount: number;
  resultSummary: unknown;
  error?: { code: string | null; message: string | null };
  approvedAt?: string | null;
  approvedBy?: string | null;
  policy: ActionProposalPolicy;
  createdAt: string;
  updatedAt: string;
}

export type ActionAuthorityResult =
  | { disposition: 'executed'; proposal: ActionProposalResult; executionResult: unknown }
  | { disposition: 'pending_approval'; proposal: ActionProposalResult }
  | { disposition: 'blocked'; proposal: ActionProposalResult }
  | { disposition: 'failed'; proposal: ActionProposalResult };

@Injectable()
export class ApiActionProposalRepo {
  constructor(private readonly config: ConfigService) {}

  async create(
    input: CreateActionProposalInput,
    control?: ToolExecutionControl,
  ): Promise<ActionAuthorityResult> {
    return withMeriOrchestratorTelemetrySpan(
      { name: 'meri.proposal.request', boundary: 'orchestrator_tool', invokedTools: [input.tool] },
      async () => {
        const execution = createMeriExecutionControl(control);
        try {
          execution.assertActive();
          const credentials = RequestCredentialsStore.get();
          if (!credentials?.bearerToken)
            throw new Error('No forwarded credential is available for action authority.');
          const env = this.config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
          const secret =
            this.config.get<string>('INTERNAL_SERVICE_SECRET') ??
            process.env.INTERNAL_SERVICE_SECRET;
          const isResearchPortfolio = isCurrentConversationResearchPortfolioTool(input.tool.trim());
          if (isResearchPortfolio && !secret) {
            throw new Error(
              'INTERNAL_SERVICE_SECRET is not configured for Research Portfolio action authority.',
            );
          }
          if ((env === 'staging' || env === 'production') && !secret) {
            throw new Error('INTERNAL_SERVICE_SECRET is not configured for action authority.');
          }
          const body = buildResearchPortfolioProposalTransport(
            input,
            currentTrustedCurrentTurnScope(),
          );
          const base = (
            this.config.get<string>('MERIV2_API_BASE_URL') ?? 'http://localhost:3000'
          ).replace(/\/+$/, '');
          const response = await fetch(`${base}/api/clio/action-proposals`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${credentials.bearerToken}`,
              'content-type': 'application/json',
              accept: 'application/json',
              ...meriOrchestratorTelemetryHeaders(),
              ...(execution.deadlineAt
                ? { 'x-meri-deadline-at': String(execution.deadlineAt) }
                : {}),
              ...(secret ? { 'x-internal-service-secret': secret } : {}),
              ...(credentials.impersonateTenantId
                ? { 'x-capiro-impersonate-tenant': credentials.impersonateTenantId }
                : {}),
            },
            body: JSON.stringify(body),
            signal: execution.signal,
          });
          if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Action authority failed: ${response.status} ${detail}`.trim());
          }
          const result = (await response.json()) as ActionAuthorityResult;
          emitMeriOrchestratorTelemetry({
            name: 'meri.proposal.finalized',
            boundary: 'orchestrator_tool',
            invokedTools: [input.tool],
            proposalId: result.proposal.proposalId,
            operationId: meriTelemetryOperationId(result),
            outcome: result.disposition,
          });
          return result;
        } finally {
          execution.dispose();
        }
      },
      'client',
    );
  }
}
