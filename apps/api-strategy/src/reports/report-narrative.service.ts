import { createHash } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { StrategyAiCredentialResolver } from "../meri/strategy-ai-credential.resolver.js";
import { StrategyOrchestratorClient } from "../meri/strategy-orchestrator.client.js";
import type { StrategyReportNarrativeResponse } from "../meri/meri.types.js";
import { formatDate } from "./report-content.js";
import { strategyTypeLabel } from "./report-labels.js";
import { buildNarrativeEvidence } from "./report-narrative-evidence.js";
import { verifyReportNarrative } from "./report-narrative-verifier.js";
import {
  REPORT_NARRATIVE_SECTION_IDS,
  type ReportNarrativeEnvelope,
  type ReportNarrativeEvidence,
  type VerifiedReportNarrative,
} from "./report-narrative.types.js";
import { stableJson } from "./report-snapshot.service.js";
import type {
  ExecutiveReportSnapshot,
  ReportMemberDetail,
} from "./report.types.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_ENTRIES = 32;
const MAX_PARAGRAPHS_PER_SECTION = 3;

export interface ReportNarrativeAvailability {
  available: boolean;
  reason: string | null;
}

export interface GenerateNarrativeInput {
  tenantId: string;
  actorUserId: string;
  bearer: string | undefined;
  snapshot: ExecutiveReportSnapshot;
  memberDetails: readonly ReportMemberDetail[];
}

/**
 * Orchestrates grounded executive prose for an export. api-strategy holds no
 * model credentials (hard guardrail), so the model call happens in the
 * meriv2-orchestrator; this service builds the evidence packet from the
 * audience-filtered snapshot, sends it under the internal-service hop, and
 * re-verifies the envelope destination-side. Any failure returns null and the
 * renderers fall back to the deterministic fact listing — a narrative hiccup
 * never blocks a report.
 */
@Injectable()
export class ReportNarrativeService {
  private readonly logger = new Logger(ReportNarrativeService.name);
  private readonly enabled: boolean;
  private readonly timeoutMs: number;
  private readonly cache = new Map<
    string,
    { value: VerifiedReportNarrative; expiresAt: number }
  >();

  constructor(
    config: ConfigService,
    private readonly orchestrator: StrategyOrchestratorClient,
    private readonly credentials: StrategyAiCredentialResolver,
  ) {
    this.enabled =
      (config.get<string>("STRATEGY_REPORT_NARRATIVE_ENABLED") ?? "").trim() ===
      "true";
    const configured = Number(
      config.get<string>("STRATEGY_REPORT_NARRATIVE_TIMEOUT_MS") ?? "",
    );
    this.timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_TIMEOUT_MS;
  }

  availability(): ReportNarrativeAvailability {
    if (!this.enabled) {
      return {
        available: false,
        reason: "Narrative generation is not enabled in this environment.",
      };
    }
    if (!this.orchestrator.configured) {
      return {
        available: false,
        reason: "The Meri orchestrator is not configured for this service.",
      };
    }
    return { available: true, reason: null };
  }

  /** Exposed so the audit log can record exactly what the model was shown. */
  evidenceFor(
    snapshot: ExecutiveReportSnapshot,
    memberDetails: readonly ReportMemberDetail[],
  ): ReportNarrativeEvidence[] {
    return buildNarrativeEvidence(snapshot, memberDetails);
  }

  async generate(
    input: GenerateNarrativeInput,
  ): Promise<VerifiedReportNarrative | null> {
    if (!this.availability().available) return null;
    const evidence = this.evidenceFor(input.snapshot, input.memberDetails);
    if (evidence.length === 0) return null;

    const key = createHash("sha256")
      .update(
        stableJson({
          audience: input.snapshot.options.audience,
          evidence: evidence.map((entry) => [entry.id, entry.text]),
        }),
      )
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const started = Date.now();
    try {
      const aiProvider = await this.credentials.resolve(input.tenantId);
      const response = await this.orchestrator.reportNarrative(
        {
          audience: input.snapshot.options.audience,
          strategy: {
            title: input.snapshot.strategy.title,
            type: strategyTypeLabel(input.snapshot.strategy.type),
            clientName: input.snapshot.client.name,
            asOf: formatDate(input.snapshot.asOf),
          },
          sections: [...REPORT_NARRATIVE_SECTION_IDS],
          maxParagraphsPerSection: MAX_PARAGRAPHS_PER_SECTION,
          evidence: evidence.map(({ id, text }) => ({ id, text })),
        },
        input.bearer,
        aiProvider,
        { tenantId: input.tenantId, clerkUserId: input.actorUserId },
        this.timeoutMs,
      );
      const verified = verifyReportNarrative({
        envelope: normalizeEnvelope(response),
        evidence,
      });
      this.logger.log(
        `report narrative generated in ${Date.now() - started}ms: ` +
          `${verified.acceptedParagraphs} accepted, ${verified.rejectedParagraphs} rejected` +
          `${verified.orchestratorDroppedParagraphs ? `, ${verified.orchestratorDroppedParagraphs} dropped upstream` : ""}` +
          `${verified.model ? ` model=${verified.model}` : ""}`,
      );
      for (const rejection of verified.rejections) {
        // Reasons and offending tokens only — never the paragraph text itself.
        this.logger.warn(
          `report narrative paragraph rejected (${rejection.sectionId}): ${rejection.reason}${
            rejection.detail ? ` [${rejection.detail}]` : ""
          }`,
        );
      }
      if (this.cache.size >= CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, {
        value: verified,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });
      return verified;
    } catch (error) {
      this.logger.warn(
        `report narrative unavailable after ${Date.now() - started}ms; rendering deterministic content: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
      return null;
    }
  }
}

function normalizeEnvelope(
  response: StrategyReportNarrativeResponse,
): ReportNarrativeEnvelope {
  return {
    sections: Array.isArray(response?.sections)
      ? (response.sections as ReportNarrativeEnvelope["sections"])
      : [],
    model: typeof response?.model === "string" ? response.model : "unknown",
    generatedAt:
      typeof response?.generatedAt === "string"
        ? response.generatedAt
        : new Date().toISOString(),
    usage: {
      inputTokens: Number(response?.usage?.inputTokens ?? 0) || 0,
      outputTokens: Number(response?.usage?.outputTokens ?? 0) || 0,
    },
    attempts: Number(response?.attempts ?? 0) || 0,
    droppedParagraphs: Number(response?.droppedParagraphs ?? 0) || 0,
    usedFallback: response?.usedFallback === true,
  };
}
