import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assuranceMetric,
  assuranceReleaseArmedFor,
  metricLogLine,
  type MeriContext,
} from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { assessStrategyDocumentClaims } from './strategy-assurance.js';
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
  repairDependencyOrder,
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
  composeAssistantSystemPrompt,
  composeDocumentDraftSystemPrompt,
  composeDraftSystemPrompt,
  composeReferenceSystemPrompt,
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
import { flattenSystemParts, type SystemPromptParts } from '../prompt-cache.helpers.js';

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
    // Prompt caching (P0-1 orchestrator parity): `pack.text`/healthNote are
    // compiled ONCE above and stay byte-identical across every repair attempt
    // below (and across every round within one attempt) — request-scoped-llm.
    // client.ts places the cache breakpoint on `systemParts.base` (persona +
    // grounding kernel, shared across ALL strategy operations, not just this
    // one), so repeats within this call — and calls from other tenants/turns
    // within the ~5-minute cache TTL — reuse that prefix.
    const systemParts = composeDraftSystemPrompt(
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
    /*
     * BEST-SO-FAR (bugfix). Each attempt used to overwrite `nodes` and `summary`
     * UNCONDITIONALLY. So a first attempt that produced a usable plan with one
     * ordering violation, followed by a repair whose model call failed or was
     * sanitized to nothing (result.input === null => nodes []), returned ZERO
     * nodes — and api-strategy's A7.5 guard then 422s
     * ("Meri couldn't produce a plan from that"), throwing away a plan the model
     * had already written. A later attempt may only REPLACE the best result when
     * it is actually better (fewer hard errors); otherwise the best is kept.
     */
    let best: {
      summary: string;
      nodes: Array<Record<string, unknown>>;
      violations: Violation[];
      errorCount: number;
    } | null = null;
    for (let attempt = 0; attempt <= MAX_REPAIRS; attempt += 1) {
      const roundStart = Date.now();
      const result = await this.runTerminal(
        // repairSuffix ('' on the first attempt) rides the DYNAMIC tail —
        // never `base` — so a repair round still hits the cached base prefix.
        { base: systemParts.base, dynamic: `${systemParts.dynamic}${repairSuffix}` },
        userText,
        PROPOSE_STRATEGY_DRAFT_TOOL,
        ctx,
        'meriv2_strategy_draft',
        // Force the terminal tool from the FIRST round on the draft path only.
        // Live evidence (ai_usage_events, 2026-07-25): round 1 returned 464 output
        // tokens of PROSE, the loop nudged, and round 2 then spent ~41s producing
        // the real plan — total ~70s against api-strategy's 60s budget, so the
        // finished plan was discarded. Forcing the tool collapses that wasted round.
        // Scoped to draft: the assistant/reference/document paths keep their
        // prose-then-nudge behaviour (and their tests).
        true,
      );
      const attemptSummary = str(result.input?.summary) ?? result.text ?? summary;
      const rawNodes = result.input?.nodes;
      const rawNodeCount = Array.isArray(rawNodes) ? rawNodes.length : 0;
      const attemptNodes = sanitizeDraftNodes(rawNodes);
      let verifierInput = this.draftVerifierInput(input, attemptNodes);
      let check = verifyPlan(verifierInput);
      // Phase 5 §4.2: before spending another model repair attempt, deterministically
      // correct simple dependency-order violations (dep-order / gate-before-dependents)
      // — a pure retiming pass, never a model round. Refuses on a cycle (no valid
      // topological order to retime along, per the plan's own instruction) or when
      // nothing actually moved; re-verifies afterward so `check` reflects what the
      // repair fixed, and best-so-far tracking below sees the improved count.
      if (check.errorCount > 0 && attemptNodes.length > 0) {
        const repair = repairDependencyOrder(verifierInput.nodes);
        if (!repair.refused && repair.changedIds.length > 0) {
          applyRepairedDates(attemptNodes, repair.nodes);
          verifierInput = this.draftVerifierInput(input, attemptNodes);
          check = verifyPlan(verifierInput);
          this.logger.log(
            `strategy draft attempt ${attempt + 1}: deterministic repair retimed ` +
              `${repair.changedIds.length} node(s), ${check.errorCount} error(s) remain`,
          );
        }
      }
      this.logger.log(
        `strategy draft attempt ${attempt + 1}/${MAX_REPAIRS + 1}: ${attemptNodes.length} node(s), ` +
          `${check.errorCount} error(s), ${Date.now() - roundStart}ms`,
      );
      // Keep this attempt only if it beats what we already have.
      if (attemptNodes.length > 0 && (best === null || check.errorCount < best.errorCount)) {
        best = {
          summary: attemptSummary,
          nodes: attemptNodes,
          violations: check.violations,
          errorCount: check.errorCount,
        };
      }
      // A deliberate empty plan (model explicitly proposed zero nodes) is a clean
      // success. But sanitizeDraftNodes can strip a non-empty/malformed response
      // (missing kind/subject/title/startsOn) down to zero nodes, and a forced-finish
      // failure returns input:null (rawNodeCount 0) too — neither is a real "nothing
      // to draft" signal, so only nodes.length === 0 short-circuits when the model
      // actually proposed zero nodes; otherwise keep repairing.
      const deliberatelyEmpty = result.input !== null && rawNodeCount === 0;
      if (deliberatelyEmpty) {
        // An explicit zero-node proposal is authoritative — surface it as-is.
        summary = attemptSummary;
        nodes = attemptNodes;
        violations = check.violations;
        return {
          summary,
          nodes,
          provenance: pack.provenance,
          violations,
          groundingHealth: mergeGroundingHealth(pack.health, input.stewardHealth),
        };
      }
      if (attemptNodes.length > 0 && check.errorCount === 0) break;
      const errs = check.violations
        .filter((v) => v.severity === 'error')
        .map((v) => `- ${v.message}`);
      this.logger.debug(`draft repair ${attempt + 1}: ${check.errorCount} error(s)`);
      repairSuffix = `\n\n# FIX THESE PROBLEMS\nYour previous plan had impossible ordering/calendar issues. Re-draft correcting ALL of these:\n${errs.join('\n')}`;
    }
    if (best) {
      summary = best.summary;
      nodes = best.nodes;
      violations = best.violations;
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
    const systemParts = composeAssistantSystemPrompt(
      input,
      pack.text,
      healthNoteFrom(pack.health, input.stewardHealth),
    );
    const result = await this.runTerminal(
      systemParts,
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
    const systemParts = composeDocumentDraftSystemPrompt(
      input,
      pack.text,
      healthNoteFrom(pack.health, input.stewardHealth),
    );
    const userText =
      input.kind === 'workspace_draft'
        ? `Draft the full document for: ${input.node.title}`
        : `Draft the full outreach message for: ${input.node.title}`;
    const result = await this.runTerminal(
      systemParts,
      userText,
      PROPOSE_DOCUMENT_DRAFT_TOOL,
      ctx,
      'meriv2_strategy_document_draft',
    );
    const sections = sanitizeDocumentSections(result.input?.sections);
    const groundingHealth = mergeGroundingHealth(pack.health, input.stewardHealth);
    // CLAIM-LEVEL pre-persistence assurance, layered ON TOP OF api-strategy's
    // structural assessGeneratedDocumentForRelease (which never inspects claim
    // support — a well-formed document of fabricated figures passes it).
    //
    // TWO-SERVICE, DOUBLY-DARK by design. The orchestrator DECIDES (armed by
    // naming `strategy` in MERI_RELEASE_GATE_SURFACES here) and api-strategy
    // ENFORCES (armed by its own MERI_RELEASE_GATE=enforce). The two services are
    // deployed independently, so each gets its own flip; with either unset the
    // blockers are still reported for observation and nothing is withheld.
    // api-strategy cannot run this itself: it deliberately has no
    // @capiro/meriv2-core dependency.
    const assurance = assessStrategyDocumentClaims({
      sections,
      provenance: pack.provenance,
      health: groundingHealth,
      kind: input.kind,
      goal: input.goal ?? null,
      ...(input.clientId ? { clientId: input.clientId } : {}),
      armed: assuranceReleaseArmedFor(process.env.MERI_RELEASE_GATE_SURFACES, 'strategy'),
    });
    this.logger.log(
      metricLogLine(
        assuranceMetric({
          name: 'release_gate',
          value: assurance.blockers.length,
          dimensions: {
            surface: input.kind === 'outreach_record' ? 'outreach' : 'strategy',
            domain: assurance.held ? 'enforce' : 'observe',
            outcome: assurance.decision,
            category: input.kind,
          },
        }),
      ),
    );
    if (assurance.held) {
      this.logger.warn(
        `[meri-assurance] strategy ${input.kind} claim hold: ${assurance.blockers.slice(0, 3).join(' ')}`,
      );
    }
    return {
      title: str(result.input?.title) ?? null,
      summary: str(result.input?.summary) ?? null,
      sections,
      provenance: pack.provenance,
      groundingHealth,
      model: result.model ?? null,
      assurance,
    };
  }

  async referenceAssist(ctx: MeriContext, input: StrategyReferenceAssistInput) {
    const systemParts = composeReferenceSystemPrompt(input);
    const result = await this.runTerminal(
      systemParts,
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
    system: string | SystemPromptParts,
    userText: string,
    tool: { name: string },
    ctx: MeriContext,
    workflow: string,
    /**
     * When true, the terminal tool is FORCED from the very first round instead of
     * letting the model reply in prose and getting nudged. Opt-in per caller: the
     * draft path passes true (a wasted prose round there costs ~20s of a 60s
     * end-to-end budget), while the assistant/reference/document paths keep the
     * prose-then-nudge behaviour their tests pin.
     */
    forceToolFromFirstRound = false,
  ): Promise<TerminalResult> {
    const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
      { role: 'user', content: userText },
    ];
    let lastText = '';

    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      let resp: ToolLoopResponse;
      const callStart = Date.now();
      try {
        resp = await this.llm.completeWithTools({
          system,
          messages,
          tools: [tool as AnthropicToolSchema],
          ...(forceToolFromFirstRound
            ? { toolChoice: { type: 'tool' as const, name: tool.name } }
            : {}),
          maxTokens: MAX_TOKENS,
          timeoutMs: this.callTimeoutMs,
        });
      } catch (e) {
        this.logger.warn(
          `strategy ${workflow} model call failed after ${Date.now() - callStart}ms: ${(e as Error).message}`,
        );
        return {
          input: null,
          text: 'Sorry — I hit an error reaching the model. Please try again.',
        };
      }
      // At LOG level (production) so a slow round is diagnosable without flipping
      // MERIV2_LOG_LEVEL to debug — the gap that made this class of timeout
      // invisible in the 2026-07-25 strategy-draft incident.
      this.logger.log(
        `strategy ${workflow} round ${round + 1}/${MAX_ROUNDS}: ${Date.now() - callStart}ms` +
          `${resp.model ? ` model=${resp.model}` : ''}`,
      );
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
        // One-off, never repeated — flatten to a plain string rather than
        // caching (a breakpoint here would only add the write premium).
        system: `${flattenSystemParts(system)}\n\n# FINISH NOW\nYou have used your budget. Call the ${tool.name} tool now with your best answer given the work so far.`,
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
 * Phase 5 §4.2: write repairDependencyOrder's retimed startsOn/endsOn back onto
 * the sanitized draft nodes it was computed from, in place. `repaired[].id` is
 * the synthetic index-as-string draftVerifierInput minted (`String(idx)`), so
 * this round-trips correctly regardless of repairDependencyOrder's topological
 * reordering of its OWN return array — every other field (kind/subject/title/
 * dependsOn/sources) is untouched.
 */
function applyRepairedDates(
  attemptNodes: Array<Record<string, unknown>>,
  repaired: VerifierNode[],
): void {
  for (const r of repaired) {
    const idx = Number(r.id);
    const n = attemptNodes[idx];
    if (!n) continue;
    n.startsOn = r.startsOn;
    n.endsOn = r.endsOn;
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
