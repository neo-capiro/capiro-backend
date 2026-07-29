import { describe, expect, it } from '@jest/globals';
import {
  persistedPolicyPacksEnforced,
  policyChannelForTool,
  policyRecipientTypeForTool,
  resolvePersistedPolicyPackMode,
} from './meri-policy-pack.service.js';

/**
 * The property under test is safety, not parsing. Arming this changes WHICH RULESET
 * binds a write, so if it ever defaulted on, deploying the code alone would swap the
 * live compliance decision for whatever rows happen to be in the table — including
 * none.
 */
describe('resolvePersistedPolicyPackMode', () => {
  it('is off when unset — deploying must never change which ruleset decides', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(resolvePersistedPolicyPackMode(raw)).toBe('off');
      expect(persistedPolicyPacksEnforced(raw)).toBe(false);
    }
  });

  it('arms only on an explicit enforce value', () => {
    expect(resolvePersistedPolicyPackMode('enforce')).toBe('enforce');
    expect(resolvePersistedPolicyPackMode(' ENFORCE ')).toBe('enforce');
    expect(persistedPolicyPacksEnforced('enforce')).toBe(true);
  });

  it('fails safe on truthy-looking or near-miss values rather than guessing', () => {
    for (const raw of ['on', 'true', '1', 'yes', 'db', 'database', 'enforced', 'persisted']) {
      expect(resolvePersistedPolicyPackMode(raw)).toBe('off');
    }
  });

  it('is a DIFFERENT variable from the release-gate switches', () => {
    // MERI_RELEASE_GATE arms chat's hold and api-strategy's generation hold;
    // MERI_RELEASE_GATE_SURFACES arms per-surface withholds. Neither may swap the
    // compliance ruleset as a side effect.
    expect(persistedPolicyPacksEnforced(process.env.MERI_RELEASE_GATE)).toBe(false);
    expect(persistedPolicyPacksEnforced(process.env.MERI_RELEASE_GATE_SURFACES)).toBe(false);
  });
});

/**
 * A policy rule can match on channel and recipient type, so these mappings are part
 * of the DECISION. Both must be conservative: an unrecognized tool must land on the
 * NARROWEST value, so it fails to match a channel-scoped rule and falls through to
 * the pack's fallback (WARN) instead of accidentally matching a permissive rule.
 */
describe('policy context derivation', () => {
  it('maps the tools whose channel is load-bearing', () => {
    expect(policyChannelForTool('send_email')).toBe('email');
    expect(policyChannelForTool('reply_email')).toBe('email');
    expect(policyChannelForTool('schedule_task')).toBe('automation');
    expect(policyChannelForTool('cancel_scheduled_task')).toBe('automation');
    expect(policyChannelForTool('create_client')).toBe('crm');
    expect(policyChannelForTool('update_client_profile')).toBe('crm');
    expect(policyChannelForTool('create_task')).toBe('crm');
    expect(policyChannelForTool('draft_policy_memo')).toBe('document');
  });

  it('defaults an UNKNOWN tool to the narrowest channel and recipient', () => {
    expect(policyChannelForTool('some_future_tool')).toBe('internal');
    expect(policyRecipientTypeForTool('some_future_tool')).toBe('unknown');
    // Not 'email'/'public': a new tool must never inherit a permissive external
    // channel rule just because nobody updated this map.
    expect(policyChannelForTool('')).toBe('internal');
  });

  it('never claims an outbound email has a known-internal recipient', () => {
    // A send whose recipient we have not actually resolved is 'unknown', so a rule
    // scoped to recipientTypes:['internal'] cannot match it.
    expect(policyRecipientTypeForTool('send_email')).toBe('unknown');
    expect(policyRecipientTypeForTool('reply_email')).toBe('unknown');
    expect(policyRecipientTypeForTool('save_note')).toBe('internal');
  });
});
