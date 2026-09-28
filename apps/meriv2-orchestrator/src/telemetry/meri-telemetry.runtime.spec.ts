import { createMeriTelemetryContext } from '@capiro/meriv2-core';
import {
  currentMeriTaskUsage,
  noteMeriProviderUsage,
  noteMeriUnknownProviderUsage,
  runWithMeriOrchestratorTelemetry,
} from './meri-telemetry.runtime.js';

describe('provider usage observations', () => {
  test('retains missing fields and partial subtotals across attempts', async () => {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
      () => {},
      async () => {
        noteMeriProviderUsage({ inputTokens: null, outputTokens: null, estimatedCostUsd: null });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'unknown',
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          unknownAttempts: 1,
        });
        noteMeriProviderUsage({ inputTokens: 8, outputTokens: null, estimatedCostUsd: 0 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 8,
          outputTokens: null,
          knownEstimatedCostUsd: null,
          unknownAttempts: 2,
        });
        noteMeriProviderUsage({ inputTokens: 2, outputTokens: 3, estimatedCostUsd: 0.02 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 10,
          outputTokens: 3,
          knownEstimatedCostUsd: 0.02,
          unknownAttempts: 2,
        });
      },
    );
  });
  test('distinguishes reported zero, failed attempts and malformed numbers', async () => {
    await runWithMeriOrchestratorTelemetry(
      createMeriTelemetryContext({ tenantId: 'tenant', actorId: 'actor' }),
      () => {},
      async () => {
        noteMeriProviderUsage({ inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'known',
          inputTokens: 0,
          outputTokens: 0,
          knownEstimatedCostUsd: 0,
        });
        noteMeriUnknownProviderUsage();
        noteMeriProviderUsage({ inputTokens: NaN, outputTokens: -1, estimatedCostUsd: Infinity });
        expect(currentMeriTaskUsage()).toMatchObject({
          status: 'partial',
          inputTokens: 0,
          outputTokens: 0,
          knownEstimatedCostUsd: 0,
          unknownAttempts: 2,
        });
      },
    );
  });
});
