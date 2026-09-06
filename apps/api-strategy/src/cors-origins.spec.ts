import { describe, expect, it } from '@jest/globals';
import { buildStrategyAllowedOrigins } from './cors-origins.js';

describe('Strategy API browser origins', () => {
  it('accepts the VNext host when production config only names the canonical host', () => {
    const origins = buildStrategyAllowedOrigins('https://app.capiro.ai');
    expect(origins.has('https://os.capiro.ai')).toBe(true);
    expect(origins.has('https://app.capiro.ai')).toBe(true);
  });

  it('preserves configured tenant origins and trims empty entries', () => {
    const origins = buildStrategyAllowedOrigins(' https://tenant.example , ,https://preview.example ');
    expect(origins.has('https://tenant.example')).toBe(true);
    expect(origins.has('https://preview.example')).toBe(true);
    expect(origins.has('')).toBe(false);
    expect(origins.has('http://localhost:5173')).toBe(false);
  });

  it('retains local development defaults without permitting unknown or lookalike origins', () => {
    const origins = buildStrategyAllowedOrigins();
    expect(origins.has('http://localhost:5173')).toBe(true);
    expect(origins.has('https://untrusted.example')).toBe(false);
    expect(origins.has('https://os.capiro.ai.untrusted.example')).toBe(false);
    expect(origins.has('http://os.capiro.ai')).toBe(false);
  });
});
