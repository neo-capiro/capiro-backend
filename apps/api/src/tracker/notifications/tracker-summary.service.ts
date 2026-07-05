/**
 * Generates a short, plain-English "what happened" summary for a tracked-bill
 * move, to add context to the alert. NOT client-specific — it explains the
 * legislative event itself (what the action means + the immediate next step).
 *
 * Tenant-scoped key: the call runs on the tenant's own Anthropic key when they
 * have an active BYO credential (decrypted via AiCredentialResolverService /
 * AES-256-GCM — no new crypto here), otherwise the global key. Spend is metered
 * to ai_usage_events with usedTenantKey for billing parity with Meri/engagement.
 *
 * Fail-safe by contract: no key, a flag-off, a provider error, or a timeout all
 * return null so the alert still sends — just without the summary line.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '../../config/config.schema.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AiCredentialResolverService } from '../../engagement/ai-credential-resolver.service.js';
import { recordAiUsageEvent } from '../../engagement/ai-usage-record.js';
import { parseProviderUsage } from '../../engagement/ai-usage-parse.js';

const SUMMARY_TIMEOUT_MS = 15_000;
const SUMMARY_MAX_TOKENS = 160;
const SUMMARY_MAX_CHARS = 360;

export interface SummaryInput {
  tenantId: string;
  displayNum: string;
  billTitle: string;
  /** Human stage label, e.g. "Passed a chamber". */
  label: string;
  /** Raw latest-action text for this move. */
  actionText: string;
  /**
   * Rendered Firm Soul + Firm Compass memory files (optional). The cycle is
   * tenant-wide with no natural per-alert user, so only firm identity is
   * carried here — never a specific user's writing voice.
   */
  firmContext?: string;
}

/** Build the user prompt for a factual, non-client-specific event summary. */
export function buildSummaryPrompt(input: SummaryInput): string {
  return [
    ...(input.firmContext ? [input.firmContext, ''] : []),
    `Bill: ${input.displayNum} — ${input.billTitle}`,
    `Stage: ${input.label}`,
    `Latest action: ${input.actionText}`,
    '',
    'In 1-2 sentences (max ~40 words), plainly explain what just happened on this',
    'bill and the immediate next step in the legislative process. Be factual and',
    'specific to this action; do not reference any client, company, or strategy;',
    'do not speculate; no preamble, no markdown — just the summary sentence(s).',
  ].join('\n');
}

const SUMMARY_SYSTEM_PROMPT =
  'You are a legislative analyst. You summarize a single Congressional bill action ' +
  'in neutral, factual, plain English for a busy reader. Never invent facts beyond ' +
  'the action text provided.';

/** Extract concatenated text from an Anthropic messages API response body. */
export function extractAnthropicText(json: unknown): string {
  const content =
    json && typeof json === 'object' ? (json as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const rec = (part ?? {}) as { type?: unknown; text?: unknown };
      return rec.type === 'text' && typeof rec.text === 'string' ? rec.text : '';
    })
    .join('\n')
    .trim();
}

/** Collapse whitespace and clamp length; returns null for an empty result. */
export function sanitizeSummary(text: string): string | null {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > SUMMARY_MAX_CHARS
    ? `${clean.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`
    : clean;
}

@Injectable()
export class TrackerSummaryService {
  private readonly logger = new Logger(TrackerSummaryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: AiCredentialResolverService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  get enabled(): boolean {
    return this.config.get('TRACKER_ALERT_SUMMARY', { infer: true });
  }

  /**
   * Firm Soul + Firm Compass (memory_items type='firm-soul'/'firm-compass',
   * slug='firm'), rendered for the summary prompt. No natural per-alert user
   * exists in this cross-tenant cycle, so only firm identity is loaded — never
   * a specific user's writing voice. Best-effort: never blocks the alert.
   */
  private async loadFirmContext(tenantId: string): Promise<string | undefined> {
    try {
      const rows = await this.prisma.withTenant(tenantId, (tx) =>
        tx.$queryRaw<Array<{ type: string; sections: unknown }>>`
          SELECT type, sections_jsonb AS sections
          FROM memory_items
          WHERE tenant_id = ${tenantId}::uuid
            AND type IN ('firm-soul', 'firm-compass')
            AND slug = 'firm'
        `,
      );
      const renderHuman = (sections: unknown): string => {
        if (!Array.isArray(sections)) return '';
        return sections
          .filter((s) => s && typeof s === 'object' && (s as { owner?: string }).owner === 'human')
          .map((s) => {
            const sec = s as { heading?: string; body?: string };
            return sec.body?.trim() ? `${sec.heading}: ${sec.body.trim()}` : '';
          })
          .filter(Boolean)
          .join('\n');
      };
      const blocks: string[] = [];
      for (const r of rows) {
        const body = renderHuman(r.sections);
        if (!body) continue;
        blocks.push(r.type === 'firm-soul' ? `Firm identity (Firm Soul):\n${body}` : `Firm direction (Firm Compass):\n${body}`);
      }
      return blocks.length ? blocks.join('\n\n') : undefined;
    } catch (e) {
      this.logger.warn(`Firm memory load failed (non-fatal): ${(e as Error).message}`);
      return undefined;
    }
  }

  /**
   * Generate a one-to-two sentence summary of the bill action, or null when
   * disabled / no credential / any failure. Never throws.
   */
  async summarize(input: SummaryInput): Promise<string | null> {
    if (!this.enabled) return null;

    const cred = await this.resolver
      .resolveProviderByTenantId(input.tenantId, 'anthropic')
      .catch((e) => {
        this.logger.warn(`Anthropic credential resolve failed: ${(e as Error).message}`);
        return null;
      });
    if (!cred) return null; // no tenant or global Anthropic key configured

    const firmContext = await this.loadFirmContext(input.tenantId);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUMMARY_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': cred.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: cred.model,
          max_tokens: SUMMARY_MAX_TOKENS,
          system: SUMMARY_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: buildSummaryPrompt({ ...input, firmContext }) }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `Tracker summary generation failed (HTTP ${res.status}); sending alert without summary. ${body.slice(0, 200)}`,
        );
        return null;
      }
      const json = (await res.json()) as unknown;
      const summary = sanitizeSummary(extractAnthropicText(json));

      // Best-effort metering — never fails the alert (records on the tenant's
      // key when used, so BYO spend bills correctly).
      await recordAiUsageEvent(
        { prisma: this.prisma, logger: this.logger },
        { tenantId: input.tenantId },
        'tracker_alert_summary',
        {
          provider: 'anthropic',
          model: cred.model,
          usage: parseProviderUsage(json),
          usedTenantKey: cred.usedTenantKey,
        },
      );

      return summary;
    } catch (e) {
      const msg =
        (e as Error).name === 'AbortError'
          ? `timed out after ${SUMMARY_TIMEOUT_MS / 1000}s`
          : (e as Error).message;
      this.logger.warn(`Tracker summary generation error (${msg}); sending alert without summary.`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
