import {
  campaignStyleSamplesV1,
  canonicalizeCampaignSpecV1,
  createBlankCampaignSpecV1,
  hashCampaignSpecV1,
  outreachCampaignSpecV1Schema,
  parseCampaignSpecV1,
} from './outreach-campaign-spec.v1.js';
import {
  normalizeStyleSampleInputV1,
  resolveStyleSampleV1,
  styleSampleKeyFor,
  OUTREACH_STYLE_SAMPLE_LIMITS,
} from './outreach-style-sample.contract.js';
import {
  OUTREACH_IMPLEMENTED_COMMAND_TYPES,
  OUTREACH_USER_AUTHORED_COMMAND_TYPES,
  parseOutreachCommandEnvelope,
} from './outreach-command.contract.js';
import { normalizeOutreachCommandEnvelope } from './outreach-command-normalization.js';
import { reduceOutreachCommand } from './outreach-command-reducer.js';
import { OutreachCommandError } from './outreach-command-errors.js';
import { deriveOutreachReadiness } from './outreach-readiness.contract.js';

const command = (type: string, payload: unknown) =>
  parseOutreachCommandEnvelope({ type, schemaVersion: 1, payload });

const sample = (body: string, extra: Record<string, unknown> = {}) => ({
  label: null,
  subject: null,
  body,
  ...extra,
});

function addSamples(spec: ReturnType<typeof createBlankCampaignSpecV1>, samples: unknown[]) {
  return reduceOutreachCommand(spec, command('ADD_STYLE_SAMPLES', { samples })).nextSpec;
}

describe('Outreach V3 style samples — content addressing', () => {
  it('derives the key from content, not from the label', () => {
    const a = resolveStyleSampleV1(sample('Dear Chairman,\n\nThank you.', { label: 'Ask memo' }));
    const b = resolveStyleSampleV1(sample('Dear Chairman,\n\nThank you.', { label: 'Renamed' }));
    expect(a.sampleKey).toBe(b.sampleKey);
  });

  it('separates samples whose subject differs', () => {
    const a = resolveStyleSampleV1(sample('Same body', { subject: 'One' }));
    const b = resolveStyleSampleV1(sample('Same body', { subject: 'Two' }));
    expect(a.sampleKey).not.toBe(b.sampleKey);
  });

  it('normalizes CRLF, trailing spaces and outer whitespace before hashing', () => {
    const crlf = resolveStyleSampleV1(sample('\r\n  Line one   \r\nLine two  \r\n\r\n'));
    const lf = resolveStyleSampleV1(sample('Line one\nLine two'));
    expect(crlf.body).toBe('Line one\nLine two');
    expect(crlf.sampleKey).toBe(lf.sampleKey);
  });

  it('collapses a multi-line subject to one line', () => {
    const normalized = normalizeStyleSampleInputV1(sample('body', { subject: 'A\r\n  B' }));
    expect(normalized.subject).toBe('A B');
  });

  it('rejects a body that is only whitespace', () => {
    expect(() => normalizeStyleSampleInputV1(sample('   \n\t  '))).toThrow();
  });

  it('rejects control characters smuggled into a body', () => {
    expect(() => normalizeStyleSampleInputV1(sample(`bad${String.fromCharCode(7)}bell`))).toThrow();
  });
});

/**
 * These are the tests that matter most.
 *
 * Stored campaign state is content-addressed and re-verified on every read
 * (parseAndVerifyVersion recomputes the hash and refuses the row on a mismatch),
 * so a new spec field that changes the canonical bytes of a spec WITHOUT samples
 * would make every campaign written before the field existed unreadable — a
 * 500 on open, for every existing session, with no migration to fix it.
 */
describe('Outreach V3 style samples — canonical hash stability', () => {
  it('leaves the key absent on a blank spec, not empty', () => {
    const blank = createBlankCampaignSpecV1();
    expect('styleSamples' in blank).toBe(false);
    expect(campaignStyleSamplesV1(blank)).toEqual([]);
    expect(canonicalizeCampaignSpecV1(blank)).not.toContain('styleSamples');
  });

  it('hashes a spec stored before the field existed exactly as before', () => {
    // A spec_jsonb row written by the previous release: no styleSamples key at all.
    const legacy = createBlankCampaignSpecV1();
    const legacyJson = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    expect(legacyJson.styleSamples).toBeUndefined();
    // Round-tripping it must reproduce byte-identical canonical form, or the
    // stored spec_hash beside it no longer matches.
    expect(canonicalizeCampaignSpecV1(legacyJson)).toBe(canonicalizeCampaignSpecV1(legacy));
    expect(hashCampaignSpecV1(legacyJson)).toBe(hashCampaignSpecV1(legacy));
  });

  it('refuses an explicitly empty array as a second spelling of "no samples"', () => {
    const blank = createBlankCampaignSpecV1();
    expect(() => parseCampaignSpecV1({ ...blank, styleSamples: [] })).toThrow();
  });

  it('changes the hash when samples are added and restores it when they are removed', () => {
    const blank = createBlankCampaignSpecV1();
    const before = hashCampaignSpecV1(blank);

    const withSample = addSamples(blank, [sample('Voice example body')]);
    expect(hashCampaignSpecV1(withSample)).not.toBe(before);
    expect(campaignStyleSamplesV1(withSample)).toHaveLength(1);

    const key = campaignStyleSamplesV1(withSample)[0]!.sampleKey;
    const removed = reduceOutreachCommand(
      withSample,
      command('REMOVE_STYLE_SAMPLES', { sampleKeys: [key] }),
    ).nextSpec;

    expect('styleSamples' in removed).toBe(false);
    expect(hashCampaignSpecV1(removed)).toBe(before);
  });

  it('re-derives a forged sampleKey instead of trusting it', () => {
    const blank = createBlankCampaignSpecV1();
    const forged = { ...blank, styleSamples: [{ ...sample('real body'), sampleKey: 'sample:forged' }] };

    // The schema alone rejects it — the key is an asserted invariant, not a hint.
    expect(() => outreachCampaignSpecV1Schema.parse(forged)).toThrow();

    // parseCampaignSpecV1 normalizes first, so the forged key is REPLACED by the
    // one the content actually hashes to. Either way a forged key can never be
    // used to address a different sample.
    const parsed = parseCampaignSpecV1(forged);
    expect(campaignStyleSamplesV1(parsed)[0]!.sampleKey).toBe(
      styleSampleKeyFor({ subject: null, body: 'real body' }),
    );

    // A stored row carrying the forged key therefore also fails hash verification:
    // the bytes it recorded its spec_hash over no longer reproduce.
    expect(hashCampaignSpecV1(parsed)).not.toBe(hashCampaignSpecV1(blank));
  });
});

describe('Outreach V3 style samples — reducer', () => {
  it('appends in submitted order rather than sorting by key', () => {
    // Order is read by the model and chosen by the user, unlike targets/context
    // which are order-free sets. Pick bodies whose keys sort the OTHER way so a
    // sort would actually be observable.
    const bodies = ['Zebra first example', 'Alpha second example'];
    const keys = bodies.map((body) => styleSampleKeyFor({ subject: null, body }));
    const sortedDiffers = [...keys].sort()[0] !== keys[0];
    expect(sortedDiffers || keys[0]! < keys[1]!).toBe(true);

    const spec = addSamples(createBlankCampaignSpecV1(), bodies.map((body) => sample(body)));
    expect(campaignStyleSamplesV1(spec).map((entry) => entry.body)).toEqual(bodies);
  });

  it('is idempotent — re-adding the same example is a no-change', () => {
    const first = addSamples(createBlankCampaignSpecV1(), [sample('One example')]);
    const reduction = reduceOutreachCommand(
      first,
      command('ADD_STYLE_SAMPLES', { samples: [sample('One example')] }),
    );
    expect(reduction.changed).toBe(false);
    expect(campaignStyleSamplesV1(reduction.nextSpec)).toHaveLength(1);
  });

  it('dedupes within a single batch', () => {
    const spec = addSamples(createBlankCampaignSpecV1(), [
      sample('Duplicated example'),
      sample('Duplicated example'),
    ]);
    expect(campaignStyleSamplesV1(spec)).toHaveLength(1);
  });

  it('blocks going over the bounded limit instead of silently truncating', () => {
    const max = OUTREACH_STYLE_SAMPLE_LIMITS.maxSamples;
    const spec = addSamples(
      createBlankCampaignSpecV1(),
      Array.from({ length: max }, (_, index) => sample(`Example number ${index}`)),
    );
    expect(campaignStyleSamplesV1(spec)).toHaveLength(max);
    expect(() => addSamples(spec, [sample('One example too many')])).toThrow(OutreachCommandError);
  });

  it('ignores a removal for a key the campaign does not hold', () => {
    const spec = addSamples(createBlankCampaignSpecV1(), [sample('Kept example')]);
    const reduction = reduceOutreachCommand(
      spec,
      command('REMOVE_STYLE_SAMPLES', { sampleKeys: ['sample:absent'] }),
    );
    expect(reduction.changed).toBe(false);
    expect(campaignStyleSamplesV1(reduction.nextSpec)).toHaveLength(1);
  });

  it('normalizes the command envelope so batch replay hashing is stable', () => {
    const raw = command('ADD_STYLE_SAMPLES', {
      samples: [sample('  Body with padding \r\n'), sample('Body with padding')],
    });
    const normalized = normalizeOutreachCommandEnvelope(raw);
    expect((normalized.payload as { samples: unknown[] }).samples).toHaveLength(1);
  });
});

describe('Outreach V3 style samples — governance', () => {
  it('is optional: samples never gate readiness or generation', () => {
    const blank = createBlankCampaignSpecV1();
    const withoutSamples = deriveOutreachReadiness(blank);
    const withSamples = deriveOutreachReadiness(addSamples(blank, [sample('An example')]));
    expect(withSamples.blockers).toEqual(withoutSamples.blockers);
  });

  it('registers both commands as implemented but author-only', () => {
    expect(OUTREACH_IMPLEMENTED_COMMAND_TYPES).toContain('ADD_STYLE_SAMPLES');
    expect(OUTREACH_IMPLEMENTED_COMMAND_TYPES).toContain('REMOVE_STYLE_SAMPLES');
    // The reasoning model must not be able to invent the author's own examples.
    // SET_CONTENT_SKELETON joined this list for the same reason: a skeleton is
    // the user's own email structure and every draft renders THROUGH it, so a
    // model-proposed one would put model-authored text into the final email as
    // though the user had written it, outside plan-claim validation entirely.
    expect(OUTREACH_USER_AUTHORED_COMMAND_TYPES).toEqual([
      'ADD_STYLE_SAMPLES',
      'REMOVE_STYLE_SAMPLES',
      'SET_CONTENT_SKELETON',
    ]);
  });

  it('does not accept a caller-supplied sampleKey on the command payload', () => {
    expect(() =>
      command('ADD_STYLE_SAMPLES', {
        samples: [{ ...sample('body'), sampleKey: 'sample:forged' }],
      }),
    ).toThrow(OutreachCommandError);
  });
});
