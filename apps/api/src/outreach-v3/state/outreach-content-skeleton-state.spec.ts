import { describe, expect, it } from '@jest/globals';
import {
  campaignContentSkeletonV1,
  hashCampaignSpecV1,
  normalizeCampaignSpecV1,
  parseCampaignSpecV1,
  createBlankCampaignSpecV1,
  type OutreachCampaignSpecV1,
} from './outreach-campaign-spec.v1.js';
import { reduceOutreachCommand } from './outreach-command-reducer.js';
import { normalizeOutreachCommandEnvelope } from './outreach-command-normalization.js';
import { OUTREACH_USER_AUTHORED_COMMAND_TYPES } from './outreach-command.contract.js';

function skeletonPayload() {
  return {
    subject: 'Meeting request: {{topic}} briefing',
    body: ['Dear {{salutation}},', '', 'Why this matters', '{{why}}'].join('\n'),
    slots: [
      { key: 'topic', label: 'Topic', instruction: 'The topic.', required: true },
      { key: 'salutation', label: 'Salutation', instruction: 'The name.', required: true },
      { key: 'why', label: 'Why', instruction: 'The connection.', required: true },
    ],
  };
}

const emptyCampaignSpecV1 = createBlankCampaignSpecV1;

function command(type: string, payload: unknown) {
  return normalizeOutreachCommandEnvelope({ type, schemaVersion: 1, payload } as never) as never;
}

const applyOutreachCommand = reduceOutreachCommand;

describe('contentSkeleton on the campaign spec — hash stability', () => {
  /**
   * This is the test that matters most in this file.
   *
   * Stored specs are content-addressed: every read re-parses spec_jsonb and
   * recomputes the hash, refusing the row as OUTREACH_STATE_CORRUPT on a
   * mismatch. If adding this field changed the canonical bytes of a spec that
   * does not use it, EVERY campaign created before this feature would 500 on
   * next open. The field is `.optional()` and deleted-when-absent precisely so
   * that cannot happen.
   */
  it('does not change the hash of a spec that has no skeleton', () => {
    const bare = emptyCampaignSpecV1();
    const hashBefore = hashCampaignSpecV1(bare);
    const roundTripped = normalizeCampaignSpecV1(parseCampaignSpecV1(JSON.parse(JSON.stringify(bare))));
    expect(hashCampaignSpecV1(roundTripped)).toBe(hashBefore);
    expect(Object.hasOwn(roundTripped, 'contentSkeleton')).toBe(false);
  });

  it('parses a legacy spec_jsonb that predates the field, without inventing the key', () => {
    // Simulates a row written before this feature: no contentSkeleton key at all.
    const legacy = JSON.parse(JSON.stringify(emptyCampaignSpecV1())) as Record<string, unknown>;
    delete legacy.contentSkeleton;
    const parsed = normalizeCampaignSpecV1(parseCampaignSpecV1(legacy));
    expect(Object.hasOwn(parsed, 'contentSkeleton')).toBe(false);
    expect(campaignContentSkeletonV1(parsed)).toBeNull();
  });

  it('omits the key rather than writing null when a skeleton is cleared', () => {
    // An explicit `contentSkeleton: null` key would be different canonical bytes
    // from an absent key, so "cleared" must be byte-identical to "never set".
    const withSkeleton = normalizeCampaignSpecV1({
      ...emptyCampaignSpecV1(),
      contentSkeleton: skeletonPayload(),
    } as OutreachCampaignSpecV1);
    const cleared = normalizeCampaignSpecV1({
      ...withSkeleton,
      contentSkeleton: undefined,
    } as OutreachCampaignSpecV1);
    expect(Object.hasOwn(cleared, 'contentSkeleton')).toBe(false);
    expect(hashCampaignSpecV1(cleared)).toBe(hashCampaignSpecV1(emptyCampaignSpecV1()));
  });

  it('DOES change the hash when a skeleton is actually present', () => {
    // The flip side: a campaign that has a skeleton must hash differently, or an
    // approval could not be pinned to the reviewed structure.
    const bare = emptyCampaignSpecV1();
    const withSkeleton = normalizeCampaignSpecV1({
      ...bare,
      contentSkeleton: skeletonPayload(),
    } as OutreachCampaignSpecV1);
    expect(hashCampaignSpecV1(withSkeleton)).not.toBe(hashCampaignSpecV1(bare));
  });

  it('hashes CRLF and LF authoring of the same skeleton identically', () => {
    // A skeleton is typed into a browser textarea. A Windows user's \r\n and a
    // Mac user's \n are the same template and must not produce two different
    // approval identities.
    const lf = normalizeCampaignSpecV1({
      ...emptyCampaignSpecV1(),
      contentSkeleton: { ...skeletonPayload(), body: 'Line one\n\n{{why}}' },
    } as OutreachCampaignSpecV1);
    const crlf = normalizeCampaignSpecV1({
      ...emptyCampaignSpecV1(),
      contentSkeleton: { ...skeletonPayload(), body: 'Line one\r\n\r\n{{why}}' },
    } as OutreachCampaignSpecV1);
    expect(hashCampaignSpecV1(crlf)).toBe(hashCampaignSpecV1(lf));
  });

  it('preserves the author’s slot ORDER instead of sorting it', () => {
    // Order drives the sequence slots are briefed to the model in, so sorting
    // would silently rewrite the author's intent.
    const spec = normalizeCampaignSpecV1({
      ...emptyCampaignSpecV1(),
      contentSkeleton: {
        subject: '',
        body: '{{zebra}} {{apple}}',
        slots: [
          { key: 'zebra', label: 'Z', instruction: 'z', required: true },
          { key: 'apple', label: 'A', instruction: 'a', required: true },
        ],
      },
    } as OutreachCampaignSpecV1);
    expect(campaignContentSkeletonV1(spec)?.slots.map((s) => s.key)).toEqual(['zebra', 'apple']);
  });
});

describe('SET_CONTENT_SKELETON reducer', () => {
  it('sets a skeleton on the campaign', () => {
    const result = applyOutreachCommand(
      emptyCampaignSpecV1(),
      command('SET_CONTENT_SKELETON', { value: skeletonPayload() }),
    );
    expect(result.changed).toBe(true);
    expect(campaignContentSkeletonV1(result.nextSpec)?.slots).toHaveLength(3);
  });

  it('clears the skeleton on null, deleting the key rather than storing null', () => {
    const set = applyOutreachCommand(
      emptyCampaignSpecV1(),
      command('SET_CONTENT_SKELETON', { value: skeletonPayload() }),
    );
    const cleared = applyOutreachCommand(
      set.nextSpec,
      command('SET_CONTENT_SKELETON', { value: null }),
    );
    expect(campaignContentSkeletonV1(cleared.nextSpec)).toBeNull();
    expect(Object.hasOwn(cleared.nextSpec, 'contentSkeleton')).toBe(false);
    // Round-trips back to the exact pre-skeleton hash — a cleared campaign is
    // indistinguishable from one that never had a template.
    expect(hashCampaignSpecV1(cleared.nextSpec)).toBe(hashCampaignSpecV1(emptyCampaignSpecV1()));
  });

  it('reports changed=false when re-applying the identical skeleton', () => {
    const first = applyOutreachCommand(
      emptyCampaignSpecV1(),
      command('SET_CONTENT_SKELETON', { value: skeletonPayload() }),
    );
    const again = applyOutreachCommand(
      first.nextSpec,
      command('SET_CONTENT_SKELETON', { value: skeletonPayload() }),
    );
    expect(again.changed).toBe(false);
  });

  it('replaces rather than merges when a different template is applied', () => {
    const first = applyOutreachCommand(
      emptyCampaignSpecV1(),
      command('SET_CONTENT_SKELETON', { value: skeletonPayload() }),
    );
    const second = applyOutreachCommand(
      first.nextSpec,
      command('SET_CONTENT_SKELETON', {
        value: {
          subject: 'Update',
          body: 'Bottom line\n{{bottom_line}}',
          slots: [{ key: 'bottom_line', label: 'Bottom line', instruction: 'x', required: true }],
        },
      }),
    );
    const skeleton = campaignContentSkeletonV1(second.nextSpec);
    expect(skeleton?.slots.map((s) => s.key)).toEqual(['bottom_line']);
  });

  it('normalizes CRLF in the command payload so a retried submit is the same intent', () => {
    const normalized = command('SET_CONTENT_SKELETON', {
      value: { ...skeletonPayload(), body: 'A\r\nB {{why}}' },
    }) as { payload: { value: { body: string } } };
    expect(normalized.payload.value.body).toBe('A\nB {{why}}');
  });

  it('normalizes a null payload without throwing', () => {
    const normalized = command('SET_CONTENT_SKELETON', { value: null }) as {
      payload: { value: null };
    };
    expect(normalized.payload.value).toBeNull();
  });
});

describe('SET_CONTENT_SKELETON is user-authored', () => {
  /**
   * A skeleton is the user's own email structure and every draft renders THROUGH
   * it, so a model-proposed skeleton would inject model-authored text into the
   * final email as though the user wrote it — bypassing Message Plan claim
   * validation entirely. Same reasoning that protects style samples.
   */
  it('is on the list the reasoning model may not propose', () => {
    expect(OUTREACH_USER_AUTHORED_COMMAND_TYPES).toContain('SET_CONTENT_SKELETON');
  });
});
