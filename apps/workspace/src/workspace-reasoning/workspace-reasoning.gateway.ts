// Workspace Reasoning Gateway — the narrow internal HTTP client to the
// existing MeriV3/OpenAI reasoning runtime (apps/meriv2-orchestrator).
//
// Per the architectural rules: "If Workspace cannot import the runtime package
// directly, create a narrow internal HTTP client to the existing MeriV3
// service." This gateway is that client. It sends structured JSON schema
// requests to the orchestrator's reasoning endpoint and returns parsed JSON.
//
// All model outputs use structured JSON schemas (function-call forcing). No
// regex extraction of arbitrary JSON. No chain-of-thought is persisted.
//
// Configuration: MERIV3_ORCHESTRATOR_URL (base URL of the orchestrator).
// Model names and reasoning settings are server-configured (never hardcoded
// into business logic). The orchestrator resolves the model from the
// reasoning level (standard/high/max) and the tenant's BYOK settings.

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  recommendDocumentSetupSchema,
  generateFollowUpQuestionsSchema,
  synthesizeBriefSchema,
  recommendContextSchema,
  analyzeContextSchema,
  generateOutlineSchema,
  planDocumentSchema,
  draftSectionSchema,
  reviseArtifactSchema,
  editorialPassSchema,
  type ReasoningLevel,
} from './workspace-reasoning.schemas.js';

/** A structured reasoning request sent to the orchestrator. */
interface ReasoningRequest {
  system: string;
  prompt: string;
  toolName: string;
  toolDescription: string;
  inputSchema: Record<string, unknown>;
  reasoningLevel: ReasoningLevel;
  /** Tenant context for BYOK resolution on the orchestrator side. */
  tenantId: string;
}

/** A structured reasoning response from the orchestrator. */
interface ReasoningResponse {
  output: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/** Result of a recommend document setup call. */
export interface RecommendDocumentSetupResult {
  documentType: { id: string; label: string; product: string };
  recommendedBlueprints: Array<{
    blueprintId: string;
    name: string;
    slug: string;
  }>;
  recommendedTheme: { id: string; name: string };
  questions: Array<{
    id: string;
    label: string;
    helpText?: string;
    required: boolean;
    answerSource?: string;
  }>;
  rationale: string;
}

/** Result of a follow-up questions call. */
export interface FollowUpQuestionsResult {
  questions: Array<{
    id: string;
    label: string;
    helpText?: string;
    field?: string;
  }>;
}

/** Result of a brief synthesis call. */
export interface SynthesizeBriefResult {
  objective?: string;
  audience?: string;
  desiredAction?: string;
  subject?: string;
  centralArgument?: string;
  evidenceInstructions?: string;
  tone?: string;
  targetPages?: number;
  deadline?: string;
  assumptions: Array<{ id: string; text: string }>;
  provenance: Record<string, 'user' | 'retrieved' | 'suggested' | 'assumed'>;
}

/** Result of a context recommendation call. */
export interface RecommendContextResult {
  includedItemIds: string[];
  excludedItems: Array<{ itemId: string; reason: string }>;
}

/** Result of a context analysis call. */
export interface AnalyzeContextResult {
  conflicts: Array<{
    id: string;
    itemIds: string[];
    type: 'numeric' | 'date' | 'status' | 'authority' | 'freshness' | 'semantic';
    description: string;
    recommendedResolution: string;
  }>;
  coverage: {
    plannedClaims: number;
    supportedClaims: number;
    missingClaims: Array<{
      claimId: string;
      description: string;
      recommendedSourceTypes: string[];
    }>;
  };
}

/** Result of an outline generation call. */
export interface GenerateOutlineResult {
  sections: Array<{
    id: string;
    title: string;
    purpose: string;
    instructions: string;
    required: boolean;
    locked: boolean;
    targetWords: { min: number; max: number };
    evidenceItemIds: string[];
  }>;
}

/** Result of a document plan call (max mode). */
export interface PlanDocumentResult {
  evidencePlan: {
    sectionEvidence: Array<{ sectionId: string; evidenceItemIds: string[] }>;
  };
  narrativePlan: { themes: string[]; flow: string };
}

/** Result of a section draft call. */
export interface DraftSectionResult {
  content: string;
  citations?: Array<{ claim: string; sourceId: string }>;
}

/** Result of a revise artifact call. */
export interface ReviseArtifactResult {
  content: string;
  rationale?: string;
}

/** Result of an editorial pass call. */
export interface EditorialPassResult {
  sectionEdits: Array<{
    sectionId: string;
    content: string;
    rationale?: string;
  }>;
}

/**
 * Narrow HTTP client to the MeriV3 reasoning runtime. All methods return
 * structured JSON; no chain-of-thought is persisted. Throws 503
 * ServiceUnavailableException when the reasoning infrastructure is down or
 * unconfigured.
 */
@Injectable()
export class WorkspaceReasoningGateway {
  private readonly logger = new Logger(WorkspaceReasoningGateway.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('MERIV3_ORCHESTRATOR_URL') ?? '').replace(/\/+$/, '');
    this.timeoutMs = Number(config.get<string>('WORKSPACE_REASONING_TIMEOUT_MS') ?? '180000');
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  private ensureConfigured(): void {
    if (!this.baseUrl) {
      throw new ServiceUnavailableException(
        'Reasoning infrastructure is not configured (MERIV3_ORCHESTRATOR_URL)',
      );
    }
  }

  /**
   * Send a structured reasoning request to the orchestrator. Returns parsed
   * JSON output. Throws ServiceUnavailableException on network/HTTP failure.
   */
  private async request(req: ReasoningRequest): Promise<unknown> {
    this.ensureConfigured();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/meri-api/reasoning`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Do NOT return the raw provider error — sanitize.
        this.logger.error(`Reasoning orchestrator returned ${res.status}`);
        throw new ServiceUnavailableException(
          'Reasoning infrastructure is temporarily unavailable',
        );
      }
      const body = (await res.json()) as ReasoningResponse;
      return body.output;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      this.logger.error(`Reasoning request failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException(
        'Reasoning infrastructure is temporarily unavailable',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async recommendDocumentSetup(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<RecommendDocumentSetupResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'recommendDocumentSetup',
      toolDescription: 'Recommend a document setup (type, blueprint, theme, questions).',
      inputSchema: recommendDocumentSetupSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'standard',
      tenantId,
    })) as RecommendDocumentSetupResult;
  }

  async generateFollowUpQuestions(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<FollowUpQuestionsResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'generateFollowUpQuestions',
      toolDescription: 'Generate follow-up questions for the current phase.',
      inputSchema: generateFollowUpQuestionsSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'standard',
      tenantId,
    })) as FollowUpQuestionsResult;
  }

  async synthesizeBrief(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<SynthesizeBriefResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'synthesizeBrief',
      toolDescription: 'Synthesize a working brief with assumption provenance.',
      inputSchema: synthesizeBriefSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'high',
      tenantId,
    })) as SynthesizeBriefResult;
  }

  async recommendContext(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<RecommendContextResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'recommendContext',
      toolDescription: 'Recommend which context items to include or exclude.',
      inputSchema: recommendContextSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'standard',
      tenantId,
    })) as RecommendContextResult;
  }

  async analyzeContext(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<AnalyzeContextResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'analyzeContext',
      toolDescription: 'Analyze context for conflicts and coverage gaps.',
      inputSchema: analyzeContextSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'high',
      tenantId,
    })) as AnalyzeContextResult;
  }

  async generateOutline(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<GenerateOutlineResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'generateOutline',
      toolDescription: 'Generate a document outline from the pinned blueprint.',
      inputSchema: generateOutlineSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'high',
      tenantId,
    })) as GenerateOutlineResult;
  }

  async planDocument(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<PlanDocumentResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'planDocument',
      toolDescription: 'Plan the document (evidence + narrative plan for max mode).',
      inputSchema: planDocumentSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'max',
      tenantId,
    })) as PlanDocumentResult;
  }

  async draftDocument(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<DraftSectionResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'draftSection',
      toolDescription: 'Draft a single section of a policy document.',
      inputSchema: draftSectionSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'max',
      tenantId,
    })) as DraftSectionResult;
  }

  async reviseArtifact(
    tenantId: string,
    system: string,
    prompt: string,
    reasoningLevel: ReasoningLevel = 'high',
  ): Promise<ReviseArtifactResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'reviseArtifact',
      toolDescription: 'Revise a selected passage.',
      inputSchema: reviseArtifactSchema as unknown as Record<string, unknown>,
      reasoningLevel,
      tenantId,
    })) as ReviseArtifactResult;
  }

  async runEditorialPass(
    tenantId: string,
    system: string,
    prompt: string,
  ): Promise<EditorialPassResult> {
    return (await this.request({
      system,
      prompt,
      toolName: 'editorialPass',
      toolDescription: 'Run an editorial pass over the complete document.',
      inputSchema: editorialPassSchema as unknown as Record<string, unknown>,
      reasoningLevel: 'max',
      tenantId,
    })) as EditorialPassResult;
  }
}
