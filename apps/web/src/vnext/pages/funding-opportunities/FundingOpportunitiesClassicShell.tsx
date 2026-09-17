import type { ReactNode } from 'react';
import { CapiroToastProvider } from '../../components/feedback/toast.js';
import { VNextBroadcastAckGate } from '../../broadcasts/VNextBroadcastAckGate.js';
import { VNextOnboardingGates } from '../../app/onboarding/VNextOnboardingGates.js';
import { VNextTrialBanner } from '../../app/onboarding/VNextTrialBanner.js';
import { AppShellUui } from '../../shell/AppShellUui/index.js';
import '../../foundations/index.css';

/**
 * The classic authenticated route tree uses the same Funding Opportunities
 * implementation as VNextRouter, but remains under App.tsx's legacy auth and
 * billing gates. This wrapper supplies the presentation root and vNext-only
 * onboarding/broadcast chrome that VNextApp normally owns.
 */
export function FundingOpportunitiesClassicShell({ children }: { children: ReactNode }) {
  return (
    <div className="capiro-vnext-root" data-web-surface="vnext" data-vnext-module="funding-opportunities">
      <CapiroToastProvider>
        <AppShellUui>
          <VNextTrialBanner />
          <VNextOnboardingGates>{children}</VNextOnboardingGates>
        </AppShellUui>
        <VNextBroadcastAckGate />
      </CapiroToastProvider>
    </div>
  );
}

export default FundingOpportunitiesClassicShell;
