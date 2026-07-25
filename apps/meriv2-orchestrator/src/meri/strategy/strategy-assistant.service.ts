import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MeriContext } from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { MeriRegistryService } from '../meri-registry.service.js';
import {
  RequestScopedLlmClient,
  type AnthropicToolSchema,
  type ToolLoopResponse,
} from '../request-scoped-llm.client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  StrategyContextPackService,
  type PackHealth,
  type PackProvenance,
} from './strategy-context-pack.service.js';
import {
  verifyPlan,
  type VerifierNode,
  type VerifyPlanInput,
  type Violation,
} from '@capiro/strategy-verifier';
import {
  PROPOSE_DOCUMENT_DRAFT_TOOL,
  PROPOSE_PLAN_EDITS_TOOL,
  PROPOSE_REFERENCE_EDITS_TOOL,
  PROPOSE_STRATEGY_DRAFT_TOOL,
  buildAssistantSystemPrompt,
  buildDocumentDraftSystemPrompt,
  buildDraftSystemPrompt,
  buildReferenceSystemPrompt,
  sanitizeDocumentSections,
  sanitizeDraftNodes,
  sanitizePlanEdits,
  sanitizeRefRows,
  type ReferenceRowLite,
  type StewardHealth,
  type StrategyAssistantInput,
  type StrategyDocumentDraftInput,
  type StrategyDraftInput,
  type StrategyReferenceAssistInput,
} from './strategy-prompt.js';

const MAX_ROUNDS = 8;
// A7.4b: 12288 (was 8192) — Sonnet 5's heavier tokenizer + dependsOn/sources on a
// 60-node plan can exceed 8192 output tokens (silent truncation). Stays < the ~16K
// non-streaming safety line.
const MAX_TOKENS = 12288;
// A5: how many times to re-prompt the model to fix hard verifier violations.
const MAX_REPAIRS = 2;

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface TerminalResult {
  input: Record<string, unknown> | null;
  text: string;
  /** The model that actually produced `input`/`text` — undefined only when
   *  every round (including the forced-finish attempt) failed outright. */
  model?: string;
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

/**
 * Strategy Planner Meri loop (G5) — clones the in-editor assistant shape
 * (bounded ≤8 rounds, Sonnet via the request-scoped BYOK2 client, per-round
 * ai_usage metering) but departs by pre-compiling the Client Context Pack and
 * running NO read tools in the loop: the only tool is the terminal
 * propose_strategy_draft / propose_plan_edits / propose_reference_edits. Runs
 * inside the controller's RequestCredentialsStore scope (bearer for the pack's
 * delegated reads + tenant key for the LLM). Returns typed output; api-strategy
 * re-validates + applies.
 */
@Injectable()
export class StrategyAssistantService {
  private readonly logger = new Logger(StrategyAssistantService.name);
  private readonly llm: RequestScopedLlmClient;
  private readonly callTimeoutMs: number;

  constructor(
    registryService: MeriRegistryService,
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly pack: StrategyContextPackService,
  ) {
    this.llm = registryService.llm;
    this.callTimeoutMs = Number.parseInt(config.get<string>('MERIV2_TIMEOUT_MS') ?? '120000', 10);
  }

  async draft(ctx: MeriContext, input: StrategyDraftInput) {
    const pack = await this.pack.compile({
      ctx,
      clientId: input.clientId,
      query: input.goal ?? '',
      slim: false,
    });
    const baseSystem = buildDraftSystemPrompt(
      input,
      pack.text,
      healthNoteFrom(pack.health, input.stewardHealth),
    );
    const userText = input.goal?.trim()
      ? `Draft the ${input.type} strategy for this goal: ${input.goal.trim()}`
      : `Draft a ${input.type} strategy for this client.`;

    // A5: LLM proposes → verifier disposes. Draft, verify against the grounding,
    // and if the plan has hard ordering/calendar errors, back-prompt with the
    // exact problems and re-draft (≤2 repairs). api-strategy re-verifies the
    // persisted plan authoritatively (A6) — this just cuts errors at the source.
    let summary = 'Drafted a plan from your goal.';
    let nodes: Array<Record<string, unknown>> = [];
    let violations: Violation[] = [];
    let repairSuffix = '';
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
      const result = await this.runTerminal(
        baseSystem + repairSuffix,
        userText,
        PROPOSE_STRATEGY_DRAFT_TOOL,
        ctx,
        'meriv2_strategy_draft',
      );
      summary = str(result.input?.summary) ?? result.text ?? summary;
      const rawNodes = result.input?.nodes;
      const rawNodeCount = Array.isArray(rawNodes) ? rawNodes.length : 0;
      nodes = sanitizeDraftNodes(rawNodes);
      const check = verifyPlan(this.draftVerifierInput(input, nodes));
      violations = check.violations;
      // A deliberate empty plan (model explicitly proposed zero nodes) is a clean
      // success. But sanitizeDraftNodes can strip a non-empty/malformed response
      // (missing kind/subject/title/startsOn) down to zero nodes, and a forced-finish
      // failure returns input:null (rawNodeCount 0) too — neither is a real "nothing
      // to draft" signal, so only nodes.length === 0 short-circuits when the model
      // actually proposed zero nodes; otherwise keep repairing.
      const deliberatelyEmpty = result.input !== null && rawNodeCount === 0;
      if (deliberatelyEmpty || (nodes.length > 0 && check.errorCount === 0)) break;
      const errs = check.violations
        .filter((v) => v.severity === 'error')
        .map((v) => `- ${v.message}`);
      this.logger.debug(`draft repair ${attempt + 1}: ${check.errorCount} error(s)`);
      repairSuffix = `\n\n# FIX THESE PROBLEMS\nYour previous plan had impossible ordering/calendar issues. Re-draft correcting ALL of these:\n${errs.join('\n')}`;
    }
    return {
      summary,
      nodes,
      provenance: pack.provenance,
      violations,
      groundingHealth: mergeGroundingHealth(pack.health, input.stewardHealth),
    };
  }

  /** Build a verifier input from proposed draft nodes: synthetic index-ids, and
   *  dependsOn indexes → those ids (out-of-range / self indexes dropped). */
  private draftVerifierInput(
    input: StrategyDraftInput,
    nodes: Array<Record<string, unknown>>,
  ): VerifyPlanInput {
    const vnodes: VerifierNode[] = nodes.map((n, idx) => ({
      id: String(idx),
      kind: String(n.kind ?? ''),
      subject: String(n.subject ?? ''),
      title: String(n.title ?? ''),
      startsOn: String(n.startsOn ?? ''),
      endsOn: n.endsOn ? String(n.endsOn) : null,
      dependsOnIds: Array.isArray(n.dependsOn)
        ? (n.dependsOn as unknown[])
            .filter(
              (d): d is number =>
                Number.isInteger(d) &&
                (d as number) >= 0 &&
                (d as number) < nodes.length &&
                d !== idx,
            )
            .map((d) => String(d))
        : [],
    }));
    const ref = (rows: ReferenceRowLite[] | undefined) =>
      (rows ?? []).map((r) => ({
        label: r.label,
        fy: r.fy ?? null,
        startsOn: r.startsOn ?? null,
        endsOn: r.endsOn ?? null,
      }));
    return {
      strategyType: input.type,
      nodes: vnodes,
      fiscal: {
        today: input.fiscal?.today ?? null,
        fys: input.fiscal?.fys ?? [],
        fyLabels: input.fiscal?.fyLabels ?? [],
        focalFy: input.fiscal?.focalFy ?? '',
      },
      congress: ref(input.reference?.congress),
      ppbeCurrentPhases: ref(input.reference?.ppbeCurrentPhases),
    };
  }

  async assistant(ctx: MeriContext, input: StrategyAssistantInput) {
    const pack = await this.pack.compile({
      ctx,
      clientId: input.clientId,
      query: input.instruction,
      slim: true,
    });
    const system = buildAssistantSystemPrompt(
      input,
      pack.text,
      healthNoteFrom(pack.health, input.stewardHealth),
    );
    const result = await this.runTerminal(
      system,
      input.instruction,
      PROPOSE_PLAN_EDITS_TOOL,
      ctx,
      'meriv2_strategy_edit',
    );
    return {
      reply: str(result.input?.reply) ?? result.text ?? 'Done.',
      summary: str(result.input?.summary) ?? null,
      edits: sanitizePlanEdits(result.input?.edits),
      provenance: pack.provenance,
      groundingHealth: mergeGroundingHealth(pack.health, input.stewardHealth),
    };
  }

  /**
   * Stage-G grounded content generation (Task a2): draft the FULL body of one
   * Execution Agent artifact for a single plan node. Reuses the bounded loop
   * verbatim (8-round cap, forced-finish, per-round metering) — no
   * verifier/repair loop, since a document/message body has no calendar/order
   * semantics to check. `slim: false` — a staged deliverable warrants the same
   * full pack depth as an initial draft, not the lighter per-edit pack.
   */
  async draftDocument(ctx: MeriContext, input: StrategyDocumentDraftInput) {
    const pack = await this.pack.compile({
      ctx,
      clientId: input.clientId,
      query: `${input.node.title} ${input.goal ?? ''}`.trim(),
      slim: false,
    });
    const system = buildDocumentDraftSystemPrompt(
      input,
      pack.text,
      healthNoteFrom(pack.health, input.stewardHealth),
    );
    const userText =
      input.kind === 'workspace_draft'
        ? `Draft the full document for: ${input.node.title}`
        : `Draft the full outreach message for: ${input.node.title}`;
    const result = await this.runTerminal(
      system,
      userText,
      PROPOSE_DOCUMENT_DRAFT_TOOL,
      ctx,
      'meriv2_strategy_document_draft',
    );
    return {
      title: str(result.input?.title) ?? null,
      summary: str(result.input?.summary) ?? null,
      sections: sanitizeDocumentSections(result.input?.sections),
      provenance: pack.provenance,
      groundingHealth: mergeGroundingHealth(pack.health, input.stewardHealth),
      model: result.model ?? null,
    };
  }

  async referenceAssist(ctx: MeriContext, input: StrategyReferenceAssistInput) {
    const system = buildReferenceSystemPrompt(input);
    const result = await this.runTerminal(
      system,
      input.instruction,
      PROPOSE_REFERENCE_EDITS_TOOL,
      ctx,
      'meriv2_strategy_edit',
    );
    // No structured rows from the model → return the working set unchanged.
    const rows = result.input
      ? sanitizeRefRows(result.input.rows)
      : (input.rows as Array<Record<string, unknown>>);
    return { reply: str(result.input?.reply) ?? result.text ?? '', rows };
  }

  /**
   * Bounded loop with a SINGLE terminal tool. The model either calls it (→ its
   * validated input) or replies in prose; a prose-only round is nudged once to
   * use the tool, and on budget exhaustion a tool-free synthesis returns text.
   */
  private async runTerminal(
    system: string,
    userText: string,
    tool: { name: string },
    ctx: MeriContext,
    workflow: string,
  ): Promise<TerminalResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: userText },
    ];
    let lastText = '';

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let resp: ToolLoopResponse;
      try {
        resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: [tool as AnthropicToolSchema],
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
        });
      } catch (e) {
        this.logger.warn(`strategy ${workflow} model call failed: ${(e as Error).message}`);
        return {
          input: null,
          text: 'Sorry — I hit an error reaching the model. Please try again.',
        };
      }
      void this.meterRound(ctx, resp, workflow);

      const content = resp.content as ContentBlock[];
      lastText = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      const terminal = content.find(
        (b): b is ContentBlock & { name: string; input?: Record<string, unknown> } =>
          b.type === 'tool_use' && b.name === tool.name,
      );
      if (terminal) {
        return { input: terminal.input ?? {}, text: lastText, model: resp.model };
      }
      // Prose-only round: nudge once to use the terminal tool, then keep going.
      messages.push({ role: 'assistant', content });
      messages.push({
        role: 'user',
        content: `Return your answer by calling the ${tool.name} tool.`,
      });
    }

    // A7.4: budget spent without a tool call — FORCE the terminal tool so even the
    // degraded path returns a schema-valid plan/edits, never prose-only.
    try {
      const resp = await this.llm.completeWithTools({
        system: `${system}\n\n# FINISH NOW\nYou have used your budget. Call the ${tool.name} tool now with your best answer given the work so far.`,
        messages,
        tools: [tool as AnthropicToolSchema],
        toolChoice: { type: 'tool', name: tool.name },
        maxTokens: MAX_TOKENS,
        timeoutMs: this.callTimeoutMs,
      });
      void this.meterRound(ctx, resp, workflow);
      const content = resp.content as ContentBlock[];
      const terminal = content.find(
        (b): b is ContentBlock & { name: string; input?: Record<string, unknown> } =>
          b.type === 'tool_use' && b.name === tool.name,
      );
      const text = content
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n')
        .trim();
      if (terminal)
        return { input: terminal.input ?? {}, text: text || lastText, model: resp.model };
      if (text) lastText = text;
    } catch (e) {
      this.logger.warn(`strategy ${workflow} forced-finish failed: ${(e as Error).message}`);
    }
    return { input: null, text: lastText || 'I could not complete that — please try again.' };
  }

  private async meterRound(
    ctx: MeriContext,
    resp: ToolLoopResponse,
    workflow: string,
  ): Promise<void> {
    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      workflow,
      {
        provider: 'anthropic',
        model: resp.model,
        usage: resp.usage,
        usedTenantKey: resp.usedTenantKey,
      },
    );
  }
}

/**
 * A8 + Stage E: the grounding-health note for the system prompt (undefined when
 * fully healthy). Covers the pack's degraded state, the Steward's missing
 * required documents, and — per wire contract (2) — a conflicted stewardHealth,
 * where the note names factA vs factB VERBATIM so the model never silently
 * picks a side.
 */
function healthNoteFrom(health: PackHealth, steward?: StewardHealth): string | undefined {
  const notes: string[] = [];
  if (health.status === 'degraded') {
    notes.push(
      `Some required context could not be loaded: ${
        health.missingRequired.join(', ') || 'unknown'
      }. Do NOT invent facts to fill these gaps — scope the plan to what you actually know and flag the uncertainty.`,
    );
  }
  if (steward?.missingRequired.length) {
    notes.push(
      `Required Steward context documents are missing: ${steward.missingRequired.join(', ')}. Do NOT invent facts to fill these gaps.`,
    );
  }
  if (steward?.status === 'conflicted' && steward.openMaterialConflicts.length) {
    const pairs = steward.openMaterialConflicts.map((c) => `- "${c.factA}" vs "${c.factB}"`);
    notes.push(
      `The client context facts contain OPEN MATERIAL CONFLICTS — do not silently choose a side; surface the conflict and flag any step relying on either fact as uncertain:\n${pairs.join('\n')}`,
    );
  }
  return notes.length ? notes.join('\n\n') : undefined;
}

/**
 * Stage E wire contract (2): carry api-strategy's stewardHealth through into the
 * response's groundingHealth (the web banner consumes it). When NO stewardHealth
 * was forwarded, the pack health passes through UNCHANGED (same object — full
 * backward compat). A conflicted steward wins the status; either side degraded
 * (and no conflict) → degraded; missingRequired accumulates both sides.
 */
function mergeGroundingHealth(pack: PackHealth, steward?: StewardHealth): PackHealth {
  if (!steward) return pack;
  const status: PackHealth['status'] =
    steward.status === 'conflicted'
      ? 'conflicted'
      : pack.status === 'degraded' || steward.status === 'degraded'
        ? 'degraded'
        : 'ok';
  return {
    status,
    missingRequired: [...pack.missingRequired, ...steward.missingRequired],
    omittedOptional: pack.omittedOptional,
    ...(steward.openMaterialConflicts.length
      ? { openMaterialConflicts: steward.openMaterialConflicts }
      : {}),
  };
}

/** Re-export for the controller's response typing. */
export type { PackHealth, PackProvenance };
