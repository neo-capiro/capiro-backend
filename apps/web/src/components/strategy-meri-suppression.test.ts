/*
 * Phase 1 §4.8 — where the GLOBAL Meri control is hidden.
 *
 * Suppressed on the strategy list and the strategy editor ONLY. The router
 * registers `/strategies/:id` as a free segment, so both UUID-like and
 * non-UUID ids must suppress; and the static child surfaces (Context, Steward,
 * agent review, Execution review) must KEEP the control, since they are
 * reachable by deep link and have no in-page assistant.
 */
import { describe, expect, test } from 'vitest';
import { isStrategyMeriSuppressed } from './strategy-meri-suppression.js';

const UUID = '3f2b6c1e-9a44-4f0b-8c21-7d9e5a1b2c3d';

describe('isStrategyMeriSuppressed', () => {
  test('suppresses on the strategy list, with or without a trailing slash', () => {
    expect(isStrategyMeriSuppressed('/strategies')).toBe(true);
    expect(isStrategyMeriSuppressed('/strategies/')).toBe(true);
  });

  test('suppresses on a UUID strategy editor route', () => {
    expect(isStrategyMeriSuppressed(`/strategies/${UUID}`)).toBe(true);
    expect(isStrategyMeriSuppressed(`/strategies/${UUID}/`)).toBe(true);
  });

  test('suppresses on a NON-UUID editor route (the router takes a free segment)', () => {
    expect(isStrategyMeriSuppressed('/strategies/abc123')).toBe(true);
    expect(isStrategyMeriSuppressed('/strategies/my-strategy-slug')).toBe(true);
    expect(isStrategyMeriSuppressed('/strategies/42')).toBe(true);
  });

  test('does NOT suppress on the Context surfaces', () => {
    expect(isStrategyMeriSuppressed('/strategies/context')).toBe(false);
    expect(isStrategyMeriSuppressed('/strategies/context/')).toBe(false);
    expect(isStrategyMeriSuppressed('/strategies/context/steward')).toBe(false);
    expect(isStrategyMeriSuppressed(`/strategies/context/${UUID}`)).toBe(false);
  });

  test('does NOT suppress on the agent review / execution surfaces', () => {
    expect(isStrategyMeriSuppressed('/strategies/agents/review')).toBe(false);
    expect(isStrategyMeriSuppressed('/strategies/agents/execution')).toBe(false);
  });

  test('does NOT suppress anywhere outside the Strategy Planner', () => {
    for (const p of [
      '/',
      '/clients',
      '/engagement',
      '/workspace',
      '/actions',
      '/intelligence/district-nexus',
      '/legiwatch',
      '/settings',
      '/strategiesomething',
      '/other/strategies',
      '/other/strategies/' + UUID,
    ]) {
      expect(isStrategyMeriSuppressed(p)).toBe(false);
    }
  });

  test('matches the router case-insensitively', () => {
    expect(isStrategyMeriSuppressed('/Strategies')).toBe(true);
    expect(isStrategyMeriSuppressed(`/Strategies/${UUID}`)).toBe(true);
    expect(isStrategyMeriSuppressed('/Strategies/Agents/Review')).toBe(false);
  });

  test('tolerates an empty pathname', () => {
    expect(isStrategyMeriSuppressed('')).toBe(false);
  });
});
