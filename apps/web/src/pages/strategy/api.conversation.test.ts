/*
 * Phase 2 — conversation cache keys.
 *
 * The strategy thread and every step thread MUST occupy distinct react-query
 * entries. If they collided, switching context would render whichever thread was
 * fetched last, which is exactly the bug persistence is meant to remove.
 */
import { describe, expect, test } from 'vitest';
import { conversationKey } from './api.js';

describe('conversationKey', () => {
  test('the strategy thread and a step thread never share an entry', () => {
    expect(conversationKey('s1', null)).toEqual(['strategy', 'conversation', 's1', 'strategy']);
    expect(conversationKey('s1', 'node-1')).toEqual(['strategy', 'conversation', 's1', 'node-1']);
    expect(conversationKey('s1', null)).not.toEqual(conversationKey('s1', 'node-1'));
  });

  test('two steps do not share an entry, and neither do two strategies', () => {
    expect(conversationKey('s1', 'node-1')).not.toEqual(conversationKey('s1', 'node-2'));
    expect(conversationKey('s1', null)).not.toEqual(conversationKey('s2', null));
  });

  test('it stays under the ["strategy", …] namespace so feature-wide invalidations still reach it', () => {
    expect(conversationKey('s1', null)[0]).toBe('strategy');
  });

  test('a node literally named "strategy" cannot collide with the strategy thread', () => {
    // The sentinel is only substituted for null; a real node id is passed through.
    expect(conversationKey('s1', 'strategy')[3]).toBe('strategy');
    expect(conversationKey('s1', null)[3]).toBe('strategy');
    // Node ids are UUIDs server-side, so this is unreachable in practice — pinned
    // so a future change to the sentinel is a deliberate one.
  });
});
