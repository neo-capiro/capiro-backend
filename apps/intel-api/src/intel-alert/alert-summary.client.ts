import { Injectable, Logger } from '@nestjs/common';

export interface AlertSummaryInput {
  tenantId: string;
  displayNum: string;
  billTitle: string;
  /** Human stage label, e.g. "Passed a chamber". */
  label: string;
  /** The verbatim latest-action text for this move. */
  actionText: string;
}

/** Headroom over apps/api's own 15s Anthropic-fetch timeout PLUS its unbounded
 *  pre-steps (tenant-key resolve, firm-context DB read, usage metering) that sit
 *  outside that 15s bound. This is a batch (emit) path, so a generous ceiling is
 *  cheap; on a genuine stall we abort and fall through to a summary-less email. */
const SUMMARY_TIMEOUT_MS = 30_000;

/**
 * "What happened" bill-alert summary generation, delegated to apps/api.
 *
 * intel-api has NO in-process LLM (no Anthropic SDK; the only Bedrock model
 * wired is Titan embeddings) — so, exactly like HearingAiCredentialResolver,
 * it POSTs over the shared INTERNAL_SERVICE_SECRET channel to the
 * InternalServiceGuard-gated `POST /api/internal/tracker/summarize`. That
 * endpoint runs the SAME TrackerSummaryService the legacy alert pipeline uses,
 * so the summary is byte-identical no matter which pipeline sends the email.
 *
 * Fail-soft: any error — or INTERNAL_SERVICE_SECRET simply not being configured
 * on this task — degrades to null, and the alert email is sent WITHOUT the
 * "What happened" line (never blocks delivery). apps/api is the single source of
 * truth for the TRACKER_ALERT_SUMMARY flag and the per-tenant BYOK key, so
 * there is deliberately no separate flag or key handling here.
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

  /** True only when the shared secret is set — otherwise the endpoint is
   *  unreachable and callers should skip generation entirely. */
  get configured(): boolean {
    return Boolean(this.sharedSecret);
  }

  async summarize(input: AlertSummaryInput): Promise<string | null> {
    if (!this.sharedSecret) return null;
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
      return typeof body.summary === 'string' && body.summary.trim() ? body.summary : null;
    } catch (err) {
      const msg =
        (err as Error).name === 'AbortError'
          ? `timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      this.logger.warn(
        `Alert summary generation failed for tenant ${input.tenantId}; sending alert without summary: ${msg}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
