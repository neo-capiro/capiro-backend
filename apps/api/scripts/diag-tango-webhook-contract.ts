/**
 * Verify P46's webhook assumptions against the provider's OWN sample delivery.
 *
 *   tsx scripts/diag-tango-webhook-contract.ts
 *   tsx scripts/diag-tango-webhook-contract.ts --event-type=opportunity.updated
 *   tsx scripts/diag-tango-webhook-contract.ts --json
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * P46's receiver takes two things from the PLAN DOCUMENT rather than from
 * anything the provider confirmed:
 *
 *   - the signature header name (`x-tango-signature`);
 *   - the envelope key names it reads a delivery id and event type from.
 *
 * That is the same unverified-assumption shape the completion matrix already
 * flags for P39's MCP connector, whose host and header also came from the plan
 * and have never been confirmed against a live endpoint. The difference is that
 * this one is CHECKABLE cheaply and read-only, because the provider publishes a
 * sample delivery — so leaving it unchecked would be a choice, not a constraint.
 *
 * Getting the header wrong is not a soft failure. Every delivery would be
 * rejected `missing_signature`, answered 401, and never retried by the provider.
 *
 * ── READ-ONLY ────────────────────────────────────────────────────────────────
 *
 * One GET. No endpoint is registered, no alert is created, nothing is written
 * to Capiro's database. Run it before canary step 14.
 *
 * ── It reports disagreement; it does not "fix" anything ──────────────────────
 *
 * A mismatch exits 1 and names both sides. It does not silently adopt the
 * provider's value — a receiver that reconfigured itself from a provider
 * response would be taking security-relevant configuration from the network.
 */
import { config as dotenvConfig } from 'dotenv';
import {
  TANGO_DELIVERY_HEADER,
  TANGO_SIGNATURE_HEADER,
} from '../src/webhooks/tango-webhook.service.js';
import type { TangoGateway, TangoWebhookSample } from '../src/external/tango/tango.types.js';

dotenvConfig();

export const EXIT_OK = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_NOT_CONFIGURED = 2;

export interface ParsedArgs {
  eventType: string | null;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const hit = argv.find((a) => a.startsWith('--event-type='));
  return {
    eventType: hit ? hit.slice('--event-type='.length) : null,
    json: argv.includes('--json'),
  };
}

export interface ContractFinding {
  check: string;
  expected: string;
  actual: string;
  agrees: boolean;
  consequence: string;
}

/**
 * Compare what P46 assumes against what the provider says.
 *
 * Pure, so the spec drives every branch without a network call.
 *
 * Header comparison is CASE-INSENSITIVE: HTTP header names are
 * case-insensitive by specification, and Express lower-cases them before a
 * handler sees them, so `X-Tango-Signature` and `x-tango-signature` are the
 * same header and flagging that as a mismatch would be a false alarm.
 */
export function compareContract(sample: TangoWebhookSample): ContractFinding[] {
  const findings: ContractFinding[] = [];

  const providerHeader = sample.signatureHeader.trim();
  findings.push({
    check: 'signature header name',
    expected: TANGO_SIGNATURE_HEADER,
    actual: providerHeader || '(provider stated none)',
    agrees: providerHeader.toLowerCase() === TANGO_SIGNATURE_HEADER.toLowerCase(),
    consequence:
      'If these differ, EVERY delivery is rejected `missing_signature` and answered 401 — and the provider will not retry a 401.',
  });

  // P46 now handles both shapes, so a batch is not a failure — but an operator
  // should know which one they are about to receive.
  findings.push({
    check: 'delivery envelope shape',
    expected: 'single event OR batch (`events` array) — both handled',
    actual: sample.isBatchEnvelope
      ? `batch: {${sample.envelopeKeys.join(', ')}} with events[]`
      : `single: {${sample.envelopeKeys.join(', ')}}`,
    agrees: true,
    consequence:
      'A batch delivery takes its envelope from the FIRST event. The whole payload is stored either way, so P47/P48 still see every event.',
  });

  // The delivery id is what makes replay free. If neither the header nor any
  // known body key carries one, every delivery is refused before it is stored.
  const KNOWN_ID_KEYS = ['delivery_id', 'deliveryId', 'id', 'external_id'];
  const idKeys = [...sample.envelopeKeys, ...sample.eventKeys];
  const hasIdKey = idKeys.some((k) => KNOWN_ID_KEYS.includes(k));
  findings.push({
    check: 'a delivery id is findable in the body',
    expected: `one of ${KNOWN_ID_KEYS.join(' / ')}, or the ${TANGO_DELIVERY_HEADER} header`,
    actual: idKeys.length === 0 ? '(no keys observed)' : idKeys.join(', '),
    agrees: hasIdKey,
    consequence:
      'Without one, the receiver falls back to the delivery header. If the provider sends neither, every delivery is refused `missing_delivery_id` — so confirm the header is sent.',
  });

  const KNOWN_TYPE_KEYS = ['event_type', 'eventType', 'event', 'type'];
  const hasTypeKey = idKeys.some((k) => KNOWN_TYPE_KEYS.includes(k));
  findings.push({
    check: 'an event type is findable in the body',
    expected: `one of ${KNOWN_TYPE_KEYS.join(' / ')}`,
    actual: idKeys.length === 0 ? '(no keys observed)' : idKeys.join(', '),
    agrees: hasTypeKey,
    consequence:
      'Without one, every delivery is refused `missing_event_type` — authenticated, stored nowhere, and answered 400 so it is never re-sent.',
  });

  return findings;
}

export function renderFindings(sample: TangoWebhookSample, findings: ContractFinding[]): string[] {
  const lines = [
    'Tango webhook contract — provider sample vs. P46 assumptions',
    `event types sampled: ${sample.eventTypes.join(', ') || '(none stated)'}`,
    '',
  ];
  for (const f of findings) {
    lines.push(`${f.agrees ? 'agrees  ' : 'DIFFERS '} ${f.check}`);
    lines.push(`           we assume : ${f.expected}`);
    lines.push(`           provider  : ${f.actual}`);
    if (!f.agrees) lines.push(`           impact    : ${f.consequence}`);
  }
  if (sample.note) {
    lines.push('', `provider note: ${sample.note}`);
  }
  lines.push('');
  lines.push(
    findings.every((f) => f.agrees)
      ? 'All checked assumptions agree with the provider sample. Nothing was written.'
      : 'MISMATCH. Nothing was written, and nothing reconfigured itself — fix the code, then re-run.',
  );
  return lines;
}

export async function probe(
  gateway: TangoGateway,
  args: ParsedArgs,
): Promise<{ exitCode: number; lines: string[] }> {
  if (!gateway.configured) {
    return {
      exitCode: EXIT_NOT_CONFIGURED,
      lines: ['TANGO_API_KEY is not configured. Nothing attempted.'],
    };
  }
  const sample = await gateway.getWebhookSamplePayload(args.eventType ?? undefined);
  const findings = compareContract(sample);
  return {
    exitCode: findings.every((f) => f.agrees) ? EXIT_OK : EXIT_MISMATCH,
    lines: renderFindings(sample, findings),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { TangoGatewayService } = await import('../src/external/tango/tango.client.js');
  const gateway = new TangoGatewayService() as unknown as TangoGateway;
  const result = await probe(gateway, args);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}

const invoked = process.argv[1] ?? '';
if (invoked.includes('diag-tango-webhook-contract')) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Unknown failure');
    process.exitCode = EXIT_MISMATCH;
  });
}
