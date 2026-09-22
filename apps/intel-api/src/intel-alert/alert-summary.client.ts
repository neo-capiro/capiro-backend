import { Injectable, Logger } from '@nestjs/common';

export interface AlertSummaryInput {
  tenantId: string;
  displayNum: string;
  billTitle: string;
  /** Human stage label, e.g. "Passed a chamber". */
  label: string;
  /** The verbatim latest-action text for this move. */
  actionText: string;
  jurisdiction?: string | null;
  chamber?: string | null;
  actionDate?: string | null;
  /** Tenant relevance is sent only to our internal API. apps/api appends it
   *  after generation and never includes it in the external-provider prompt. */
  why?: string | null;
  matchedTags?: string[];
  /** Verified next steps from `proceduralOutlook`. Both this and `blockedBy`
   *  are declared on apps/api's SummarizeAlertDto — the global ValidationPipe
   *  runs forbidNonWhitelisted, so an undeclared key would 400 and fail soft to
   *  a fallback narrative for EVERY alert. */
  allowedNextSteps?: string[];
  blockedBy?: string[];
}

const SUMMARY_MAX_CHARS = 640;

function cleanNarrative(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_MAX_CHARS) return clean;
  return `${clean.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
}

function clampFragment(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function specificOtherChamberStep(step: string, chamber: string | null | undefined): string {
  if (step !== 'Referral in the other chamber' || !chamber) return step;
  const normalized = chamber.trim().toLowerCase();
  if (/^(h|house|lower|assembly)$/.test(normalized)) return 'Senate action';
  if (/^(s|senate|upper)$/.test(normalized)) return 'House action';
  return step;
}

/** Source-only fallback used when apps/api or its provider is unavailable. */
export function buildDeterministicAlertNarrative(input: AlertSummaryInput): string {
  const dated = input.actionDate ? ` (${input.actionDate})` : '';
  const event = `${input.displayNum} — ${input.label}${dated}: ${input.actionText}`;
  const relevance = input.why
    ? `Why it matters: ${input.why}`
    : (input.matchedTags ?? []).filter(Boolean).length
      ? `Tracked topics: ${(input.matchedTags ?? []).filter(Boolean).slice(0, 6).join(', ')}.`
      : '';
  const blocked = (input.blockedBy ?? []).filter(Boolean);
  const steps = (input.allowedNextSteps ?? [])
    .filter(Boolean)
    .slice(0, 2)
    .map((step) => specificOtherChamberStep(step, input.chamber));
  const procedure = blocked.length
    ? `Current constraint: ${blocked[0]}.`
    : steps.length === 1
      ? `Expected next step: ${steps[0]}.`
      : steps.length > 1
        ? `Possible next steps: ${steps.join('; ')}.`
        : 'Next step: not verified.';
  const suffix = [clampFragment(relevance, 220), procedure].filter(Boolean).join(' ');
  const eventBudget = Math.max(0, SUMMARY_MAX_CHARS - suffix.length - (suffix ? 1 : 0));
  const boundedEvent = eventBudget > 0 ? clampFragment(event, eventBudget) : '';
  return cleanNarrative([boundedEvent, suffix].filter(Boolean).join(' '));
}

/** Headroom over apps/api's own 15s Anthropic-fetch timeout PLUS its unbounded
 *  pre-steps (tenant-key resolve, firm-context DB read, usage metering) that sit
 *  outside that 15s bound. This is a batch (emit) path, so a generous ceiling is
 *  cheap; on a genuine stall we abort and use deterministic source-only copy. */
const SUMMARY_TIMEOUT_MS = 30_000;

/**
 * Federal/state bill-alert narrative generation, delegated to apps/api.
 *
 * intel-api has NO in-process LLM (no Anthropic SDK; the only Bedrock model
 * wired is Titan embeddings) — so, exactly like HearingAiCredentialResolver,
 * it POSTs over the shared INTERNAL_SERVICE_SECRET channel to the
 * InternalServiceGuard-gated `POST /api/internal/tracker/summarize`. That
 * endpoint runs the SAME TrackerSummaryService the legacy alert pipeline uses,
 * so the summary is byte-identical no matter which pipeline sends the email.
 *
 * Fail-soft: any error — or INTERNAL_SERVICE_SECRET simply not being configured
 * on this task — returns a deterministic source-grounded narrative. Delivery is
 * never blocked and email copy does not regress to a generic alert.
 *
 * Reads raw process.env (not ConfigService) to match every other tracker/
 * LegiWatch env read in intel-api and to work unchanged in the one-off
 * `task emit-bill-alerts` runner, which has no booted ConfigModule.
 */
@Injectable()
export class AlertSummaryClient {
  private readonly logger = new Logger(AlertSummaryClient.name);
  private readonly apiBaseUrl = (process.env.API_BASE_URL ?? 'https://app.capiro.ai').replace(
    /\/+$/,
    '',
  );
  private readonly sharedSecret = process.env.INTERNAL_SERVICE_SECRET;

  /** True only when the internal LLM endpoint is reachable. */
  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async summarize(input: AlertSummaryInput): Promise<string | null> {
    if (!this.sharedSecret) return buildDeterministicAlertNarrative(input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.apiBaseUrl}/api/internal/tracker/summarize`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-service-secret': this.sharedSecret,
        },
        body: JSON.stringify(input),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { summary?: string | null };
      return typeof body.summary === 'string' && body.summary.trim()
        ? cleanNarrative(body.summary)
        : buildDeterministicAlertNarrative(input);
    } catch (err) {
      const msg =
        (err as Error).name === 'AbortError'
          ? `timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      this.logger.warn(
        `Alert summary generation failed for tenant ${input.tenantId}; using deterministic fallback: ${msg}`,
      );
      return buildDeterministicAlertNarrative(input);
    } finally {
      clearTimeout(timer);
    }
  }
}
