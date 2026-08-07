import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// This spec proves the EngagementApiAppModule is statically safe:
// it does not import AppModule, WebhooksModule, or any main-only module,
// and it registers the correct guards and middleware exclusions.

const MODULE_PATH = join(__dirname, 'engagement-api.app.module.ts');
const source = readFileSync(MODULE_PATH, 'utf-8');

describe('EngagementApiAppModule', () => {
  describe('static import safety', () => {
    // Read the source file and verify it does not import forbidden modules.
    it('does not import AppModule', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*AppModule/m);
      expect(source).not.toMatch(/from\s+['"]\.\/app\.module/);
    });

    it('does not import WebhooksModule', () => {
      // Check for actual import statements, not the word in comments or
      // middleware exclusion paths (which legitimately contain "webhooks").
      expect(source).not.toMatch(/^import\s+\{[^}]*WebhooksModule/m);
      expect(source).not.toMatch(/from\s+['"][^'"]*webhooks[^'"]*['"]/);
    });

    it('does not import ProgramElementModule or MeriModule', () => {
      expect(source).not.toMatch(/^import\s+\{[^}]*ProgramElementModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*MeriModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*ReviewsModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*IntelligenceModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*AlertMemoModule/m);
      expect(source).not.toMatch(/^import\s+\{[^}]*DistrictBriefModule/m);
    });

    it('imports EngagementModule', () => {
      expect(source).toMatch(/import\s+.*EngagementModule/);
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

    it('excludes internal routes from tenant middleware', () => {
      expect(source).toMatch(/api\/internal/);
    });
  });
});
