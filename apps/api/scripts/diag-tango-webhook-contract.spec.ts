import { TANGO_SIGNATURE_HEADER } from '../src/webhooks/tango-webhook.service.js';
import type { TangoGateway, TangoWebhookSample } from '../src/external/tango/tango.types.js';
import {
  EXIT_MISMATCH,
  EXIT_NOT_CONFIGURED,
  EXIT_OK,
  compareContract,
  parseArgs,
  probe,
  renderFindings,
} from './diag-tango-webhook-contract.js';

/**
 * Verifies P46's webhook assumptions against the provider's own sample.
 *
 * Every test drives the pure comparison or a recording fake — nothing here
 * reaches the network, and no real key is read.
 */

function sample(over: Partial<TangoWebhookSample> = {}): TangoWebhookSample {
  return {
    signatureHeader: 'X-Tango-Signature',
    eventTypes: ['opportunity.updated'],
    envelopeKeys: ['timestamp', 'events'],
    isBatchEnvelope: true,
    eventKeys: ['delivery_id', 'event_type', 'event_id'],
    note: null,
    ...over,
  };
}

function find(s: TangoWebhookSample, check: string) {
  return compareContract(s).find((f) => f.check === check);
}

describe('parseArgs', () => {
  it('defaults to all event types, text output', () => {
    expect(parseArgs([])).toEqual({ eventType: null, json: false });
  });

  it('reads an event-type filter and --json', () => {
    expect(parseArgs(['--event-type=forecast.published', '--json'])).toEqual({
      eventType: 'forecast.published',
      json: true,
    });
  });
});

describe('compareContract — signature header', () => {
  it('agrees when the provider header matches, ignoring case', () => {
    // HTTP header names are case-insensitive by spec and Express lower-cases
    // them before a handler sees them, so flagging case would be a false alarm.
    expect(
      find(sample({ signatureHeader: 'X-Tango-Signature' }), 'signature header name')?.agrees,
    ).toBe(true);
    expect(
      find(sample({ signatureHeader: 'x-tango-signature' }), 'signature header name')?.agrees,
    ).toBe(true);
  });

  it('DIFFERS when the provider signs with another header', () => {
    const f = find(sample({ signatureHeader: 'X-Signature' }), 'signature header name');
    expect(f?.agrees).toBe(false);
    expect(f?.expected).toBe(TANGO_SIGNATURE_HEADER);
    expect(f?.actual).toBe('X-Signature');
  });

  it('names the real consequence rather than a generic mismatch', () => {
    // This is the failure that matters: a 401 is terminal for the provider.
    expect(
      find(sample({ signatureHeader: 'X-Other' }), 'signature header name')?.consequence,
    ).toMatch(/401.*not retry|not retry.*401/s);
  });

  it('DIFFERS when the provider states no header at all', () => {
    const f = find(sample({ signatureHeader: '   ' }), 'signature header name');
    expect(f?.agrees).toBe(false);
    expect(f?.actual).toContain('stated none');
  });
});

describe('compareContract — envelope shape', () => {
  it('a BATCH envelope is reported, and is not a failure', () => {
    // P46 handles both shapes since the batch hardening; the operator should
    // still know which one is coming.
    const f = find(sample({ isBatchEnvelope: true }), 'delivery envelope shape');
    expect(f?.agrees).toBe(true);
    expect(f?.actual).toContain('batch');
  });

  it('a SINGLE-event envelope is reported too', () => {
    const f = find(
      sample({
        isBatchEnvelope: false,
        envelopeKeys: ['delivery_id', 'event_type'],
        eventKeys: [],
      }),
      'delivery envelope shape',
    );
    expect(f?.agrees).toBe(true);
    expect(f?.actual).toContain('single');
  });
});

describe('compareContract — findable identifiers', () => {
  it('agrees when the batch events carry a delivery id and event type', () => {
    expect(find(sample(), 'a delivery id is findable in the body')?.agrees).toBe(true);
    expect(find(sample(), 'an event type is findable in the body')?.agrees).toBe(true);
  });

  it('agrees when a SINGLE envelope carries them at the top level', () => {
    const s = sample({
      isBatchEnvelope: false,
      envelopeKeys: ['delivery_id', 'event_type'],
      eventKeys: [],
    });
    expect(find(s, 'a delivery id is findable in the body')?.agrees).toBe(true);
    expect(find(s, 'an event type is findable in the body')?.agrees).toBe(true);
  });

  it('DIFFERS when no known delivery-id key appears anywhere', () => {
    const s = sample({ envelopeKeys: ['timestamp'], eventKeys: ['event_type'] });
    expect(find(s, 'a delivery id is findable in the body')?.agrees).toBe(false);
  });

  it('DIFFERS when no known event-type key appears anywhere', () => {
    const s = sample({ envelopeKeys: ['timestamp'], eventKeys: ['delivery_id'] });
    const f = find(s, 'an event type is findable in the body');
    expect(f?.agrees).toBe(false);
    expect(f?.consequence).toContain('never re-sent');
  });

  it('reports honestly when the sample carried no keys at all', () => {
    const s = sample({ envelopeKeys: [], eventKeys: [] });
    expect(find(s, 'a delivery id is findable in the body')?.actual).toContain('no keys observed');
  });
});

describe('renderFindings', () => {
  it('shows both sides for a mismatch, and the impact', () => {
    const s = sample({ signatureHeader: 'X-Other' });
    const text = renderFindings(s, compareContract(s)).join('\n');
    expect(text).toContain('DIFFERS');
    expect(text).toContain('we assume');
    expect(text).toContain('provider');
    expect(text).toContain('impact');
  });

  it('says nothing was written, on both paths', () => {
    const ok = renderFindings(sample(), compareContract(sample())).join('\n');
    const bad = renderFindings(
      sample({ signatureHeader: 'X-Other' }),
      compareContract(sample({ signatureHeader: 'X-Other' })),
    ).join('\n');
    expect(ok).toContain('Nothing was written');
    expect(bad).toContain('Nothing was written');
  });

  it('states that nothing reconfigured itself from the provider response', () => {
    // Taking security-relevant configuration from a network response is the
    // thing this tool must never do.
    const s = sample({ signatureHeader: 'X-Other' });
    expect(renderFindings(s, compareContract(s)).join('\n')).toContain(
      'nothing reconfigured itself',
    );
  });

  it('surfaces a provider note when there is one', () => {
    const s = sample({ note: 'signatures use the raw body' });
    expect(renderFindings(s, compareContract(s)).join('\n')).toContain(
      'signatures use the raw body',
    );
  });
});

describe('probe', () => {
  function gw(s: TangoWebhookSample, configured = true) {
    const calls: string[] = [];
    const gateway = {
      configured,
      getWebhookSamplePayload: async (t?: string) => {
        calls.push(`getWebhookSamplePayload:${t ?? 'all'}`);
        return s;
      },
    } as unknown as TangoGateway;
    return { gateway, calls };
  }

  it('exits 0 when every assumption agrees', async () => {
    const { gateway } = gw(sample());
    expect((await probe(gateway, parseArgs([]))).exitCode).toBe(EXIT_OK);
  });

  it('exits 1 on a mismatch', async () => {
    const { gateway } = gw(sample({ signatureHeader: 'X-Other' }));
    expect((await probe(gateway, parseArgs([]))).exitCode).toBe(EXIT_MISMATCH);
  });

  it('does nothing at all without a key', async () => {
    const { gateway, calls } = gw(sample(), false);
    const r = await probe(gateway, parseArgs([]));
    expect(r.exitCode).toBe(EXIT_NOT_CONFIGURED);
    expect(calls).toEqual([]);
  });

  it('issues exactly ONE read call and no writes', async () => {
    const { gateway, calls } = gw(sample());
    await probe(gateway, parseArgs([]));
    expect(calls).toEqual(['getWebhookSamplePayload:all']);
  });

  it('passes an event-type filter through', async () => {
    const { gateway, calls } = gw(sample());
    await probe(gateway, parseArgs(['--event-type=forecast.published']));
    expect(calls).toEqual(['getWebhookSamplePayload:forecast.published']);
  });
});
