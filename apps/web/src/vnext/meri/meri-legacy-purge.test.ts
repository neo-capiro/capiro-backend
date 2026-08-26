import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const srcDir = resolve(process.cwd(), 'src');

function read(rel: string): string {
  return readFileSync(resolve(srcDir, rel), 'utf8');
}

/**
 * Legacy-UI purge contracts (Meri module + vNext app root).
 *
 * apps/web is ONE Vite bundle serving app.capiro.ai (legacy) and os.capiro.ai
 * (vNext); nothing is surface-tree-shaken, so any RUNTIME import from
 * vnext/** into an antd- or legacy-CSS-carrying module ships that legacy UI
 * to the os surface. These tests pin the extraction seams so the imports
 * don't quietly regress. Type-only imports are fine — they erase at runtime.
 */
describe('vNext Meri + app root stay off legacy UI at runtime', () => {
  test('the chat controller imports the UI-free shared modules, not the antd components', () => {
    const source = read('components/chat/useMeriChatController.ts');
    // ChatInput is antd-heavy and pulls managed-mcp-apps.css; WorkPerformed
    // pulls antd icons and ContextInspector.css. ~20 vnext/meri files mount
    // this controller, so one value import here taints the whole module.
    expect(source).not.toContain("from './ChatInput.js'");
    expect(source).not.toContain("from './WorkPerformed.js'");
    expect(source).not.toContain("from './MessageFeedback.js'");
    expect(source).toContain("from './chat-attachments.js'");
    expect(source).toContain("from './work-performed-shared.js'");
  });

  test('the vNext composer uses the shared attachment module and vNext icons', () => {
    const source = read('vnext/meri/VNextMeriComposer.tsx');
    expect(source).not.toContain('components/chat/ChatInput.js');
    expect(source).toContain('components/chat/chat-attachments.js');
    // antd attachmentKindIcon must not render on this surface (prose mentions
    // in comments are fine; a call is not).
    expect(source).not.toContain('attachmentKindIcon(');
  });

  test('vNext Meri uses governed Institutional Memory, never the legacy Clio memory adapter', () => {
    const tab = read('vnext/meri/MeriMemoryTab.tsx');
    const callout = read('vnext/meri/MeriMemoryCallout.tsx');
    const rail = read('vnext/meri/VNextMeriContextRail.tsx');
    const message = read('vnext/meri/VNextMeriMessage.tsx');
    for (const source of [tab, callout, rail, message]) {
      expect(source).not.toContain('/api/clio/memory');
      expect(source).not.toContain('MeriLearnedMemory');
      expect(source).not.toContain('controller.learnedMemories');
    }
    expect(tab).toContain('/api/memory/review/candidates');
    expect(tab).toContain('/api/memory/proposals');
    expect(tab).toContain('MeriContextPacket');

    const workspace = read('vnext/meri/VNextMeriWorkspace.tsx');
    const controller = read('components/chat/useMeriChatController.ts');
    expect(workspace).toContain('legacyMemoryEnabled: false');
    expect(controller).toContain('if (!legacyMemoryEnabled) return');
    expect(controller).toContain('if (!legacyMemoryEnabled || isStreaming || !sessionId) return');
  });

  test('the vNext message renders the re-skinned analysis card and feedback dialog', () => {
    const source = read('vnext/meri/VNextMeriMessage.tsx');
    expect(source).not.toContain('components/chat/AnalysisChartCard.js');
    expect(source).not.toContain('components/chat/MessageFeedback.js');
    expect(source).toContain('<MeriAnalysisChartCard');
    expect(source).toContain('<MeriMessageFeedback');
  });

  test('the re-skinned analysis card shares the artifact contract, endpoints and CSV logic', () => {
    const source = read('vnext/meri/MeriAnalysisChartCard.tsx');
    expect(source).toContain('components/chat/analysis-chart-shared.js');
    expect(source).toContain('/api/clio/analysis-artifacts/');
    expect(source).toContain('buildAnalysisCsv');
    // No second copy of the security-relevant CSV neutralization.
    expect(source).not.toContain('neutralizeAnalysisCsvCell(');
  });

  test('the vNext app root mounts the re-skinned onboarding chrome, not the ob-overlay ports', () => {
    const source = read('vnext/app/VNextApp.tsx');
    expect(source).not.toContain('components/onboarding/OnboardingGates.js');
    expect(source).not.toContain('components/onboarding/TrialBanner.js');
    expect(source).toContain('<VNextOnboardingGates');
    expect(source).toContain('<VNextTrialBanner');
  });

  test('vNext onboarding gates keep the legacy gate logic: same endpoints, keys and events', () => {
    const source = read('vnext/app/onboarding/VNextOnboardingGates.tsx');
    for (const anchor of [
      "'/onboard-api/setup/state'",
      "'/api/engagement/integrations'",
      "['onboarding', 'setup-state']",
      "['engagement-integrations']",
      '/api/engagement/integrations/microsoft/start',
      '/api/engagement/integrations/google/start',
      'GATE_SHOWN_KEY',
      'START_TOUR_EVENT',
      "'/api/me'",
      'tourCompleted',
      "role !== 'capiro_admin'",
      "role !== 'client_portal_user'",
    ]) {
      expect(source).toContain(anchor);
    }
    expect(source).toContain('components/onboarding/onboarding-shared.js');
    // The stylesheet may be discussed in comments but never imported.
    expect(source).not.toMatch(/import ['"][^'"]*ob-overlay\.css['"]/);
  });

  test('the shared seam modules stay UI-free', () => {
    for (const rel of [
      'components/chat/chat-attachments.ts',
      'components/chat/work-performed-shared.ts',
      'components/chat/message-feedback-shared.ts',
      'components/chat/analysis-chart-shared.ts',
      'components/onboarding/onboarding-shared.ts',
    ]) {
      const source = read(rel);
      expect(source, `${rel} must not import antd`).not.toMatch(/from ['"](antd|@ant-design)/);
      expect(source, `${rel} must not import CSS`).not.toMatch(/import ['"][^'"]+\.css['"]/);
      expect(source, `${rel} must not import react`).not.toMatch(/from ['"]react['"]/);
    }
  });
});
