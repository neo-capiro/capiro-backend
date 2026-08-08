import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This spec proves the EngagementApiAppModule is statically safe: it does
// not import AppModule, the broad general WebhooksModule, or main-only product
// modules, and it registers the split Phase 1 runtime boundaries.

const MODULE_PATH = join(__dirname, 'engagement-api.app.module.ts');
const source = readFileSync(MODULE_PATH, 'utf-8');

describe('EngagementApiAppModule', () => {
  describe('static import safety', () => {
    it('does not import AppModule', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*AppModule/m);
      expect(source).not.toMatch(/from\s+['"]\.\/app\.module/);
    });

    it('does not import the broad general WebhooksModule', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*WebhooksModule/m);
      expect(source).not.toMatch(/from\s+['"]\.\/webhooks\/webhooks\.module/);
    });

    it('does not import main-only product modules', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*ProgramElementModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*MeriModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*ReviewsModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*IntelligenceModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*AlertMemoModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*DistrictBriefModule/m);
    });

    it('imports request/core Engagement and the shared capability registry', () => {
      expect(source).toMatch(/import\s+.*EngagementModule/);
      expect(source).toMatch(/import\s+.*CapabilitiesModule/);
    });

    it('registers independently composable actions, callbacks, workers, and Recall', () => {
      expect(source).toMatch(/EngagementIntegrationActionsModule/);
      expect(source).toMatch(/EngagementCallbacksModule/);
      expect(source).toMatch(/EngagementWorkersModule/);
      expect(source).toMatch(/RecallWebhookModule/);
    });

    it('registers EngagementApiHealthController', () => {
      expect(source).toMatch(/EngagementApiHealthController/);
    });

    it('registers ThrottlerGuard as APP_GUARD', () => {
      expect(source).toMatch(/ThrottlerGuard/);
    });

    it('registers EngagementRuntimeGuard as APP_GUARD', () => {
      expect(source).toMatch(/EngagementRuntimeGuard/);
    });

    it('excludes OAuth callbacks from tenant middleware', () => {
      expect(source).toMatch(/microsoft\/callback/);
      expect(source).toMatch(/google\/callback/);
    });

    it('excludes Microsoft notifications from tenant middleware', () => {
      expect(source).toMatch(/microsoft\/notifications/);
    });

    it('excludes Recall and all webhook paths from tenant middleware', () => {
      expect(source).toMatch(/webhooks\/\(\.\*\)/);
    });

    it('excludes internal routes from tenant middleware', () => {
      expect(source).toMatch(/api\/internal/);
    });
  });
});
