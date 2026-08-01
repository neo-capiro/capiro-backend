import { describe, expect, it } from '@jest/globals';
import { memoryGovernanceCenterEnabled } from './memory-governance-center.switch.js';

describe('memoryGovernanceCenterEnabled', () => {
  it('requires the exact center, lifecycle, and authorization controls', () => {
    expect(
      memoryGovernanceCenterEnabled({
        MEMORY_GOVERNANCE_CENTER: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
      } as NodeJS.ProcessEnv),
    ).toBe(true);

    for (const center of [undefined, '', 'true', '1', 'on', 'enabled', 'off']) {
      expect(
        memoryGovernanceCenterEnabled({
          MEMORY_GOVERNANCE_CENTER: center,
          MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
          MEMORY_GOVERNANCE_ENFORCE: 'enforce',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    }
  });

  it('never arms when either governed prerequisite is off', () => {
    expect(
      memoryGovernanceCenterEnabled({
        MEMORY_GOVERNANCE_CENTER: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'off',
        MEMORY_GOVERNANCE_ENFORCE: 'enforce',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
    expect(
      memoryGovernanceCenterEnabled({
        MEMORY_GOVERNANCE_CENTER: 'enforce',
        MEMORY_GOVERNANCE_LIFECYCLE: 'enforce',
        MEMORY_GOVERNANCE_ENFORCE: 'off',
      } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});
