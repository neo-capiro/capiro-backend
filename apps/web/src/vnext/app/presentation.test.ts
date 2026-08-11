import { describe, expect, it } from 'vitest';
import { resolveWebPresentation } from './presentation.js';

describe('resolveWebPresentation', () => {
  it('keeps the canonical presentation when WEB_SURFACE is unset or canonical', () => {
    expect(resolveWebPresentation()).toBe('canonical');
    expect(resolveWebPresentation('')).toBe('canonical');
    expect(resolveWebPresentation('canonical')).toBe('canonical');
  });

  it('selects vNext only for an explicit vnext runtime surface', () => {
    expect(resolveWebPresentation('vnext')).toBe('vnext');
    expect(resolveWebPresentation(' VNEXT ')).toBe('vnext');
  });
});
