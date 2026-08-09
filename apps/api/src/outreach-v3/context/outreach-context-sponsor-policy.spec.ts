import { createResolvedContextRefV1 } from '../../capabilities/context/outreach-context.contract.js';
import { createBlankCampaignSpecV1 } from '../state/outreach-campaign-spec.v1.js';
import {
  assertOutreachContextSponsorIsolation,
  OutreachContextSponsorPolicyError,
} from './outreach-context-sponsor-policy.js';

const clientA = '00000000-0000-4000-8000-000000000601';
const clientB = '00000000-0000-4000-8000-000000000602';

function clientContext(clientId: string) {
  return createResolvedContextRefV1({
    locator: {
      source: 'memory_item',
      id: '00000000-0000-4000-8000-000000000603',
      clientId,
    },
    contextClass: 'campaign_fact',
    scope: { kind: 'campaign' },
    title: 'Client fact',
    summary: 'Approved client-specific fact.',
    clientId,
    verificationClass: 'first_party',
    sensitivity: 'confidential',
    instructionsAllowed: false,
    usableAsEvidence: true,
    usableAsWritingGuidance: false,
    sourceSnapshot: {
      system: 'capiro_memory',
      version: 'v1',
      lastVerifiedAt: '2026-08-09T00:00:00.000Z',
    },
  });
}

describe('Outreach context sponsor isolation', () => {
  it('allows tenant-neutral context without a client sponsor', () => {
    expect(() => assertOutreachContextSponsorIsolation(createBlankCampaignSpecV1())).not.toThrow();
  });

  it('allows client-specific context for the exact sole client sponsor', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId: clientA }] };
    spec.context.campaignFactRefs = [clientContext(clientA)];
    expect(() => assertOutreachContextSponsorIsolation(spec)).not.toThrow();
  });

  it('rejects client-specific context without a sole client sponsor', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = { kind: 'firm', label: null, clientRefs: [] };
    spec.context.campaignFactRefs = [clientContext(clientA)];
    expect(() => assertOutreachContextSponsorIsolation(spec)).toThrow(
      OutreachContextSponsorPolicyError,
    );
  });

  it('rejects context belonging to another client', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = { kind: 'client', label: null, clientRefs: [{ clientId: clientA }] };
    spec.context.campaignFactRefs = [clientContext(clientB)];
    expect(() => assertOutreachContextSponsorIsolation(spec)).toThrow(
      OutreachContextSponsorPolicyError,
    );
  });

  it('rejects client-specific shared context for multi-client campaigns', () => {
    const spec = createBlankCampaignSpecV1();
    spec.sponsor = {
      kind: 'multi_client',
      label: null,
      clientRefs: [{ clientId: clientA }, { clientId: clientB }],
    };
    spec.context.campaignFactRefs = [clientContext(clientA)];
    expect(() => assertOutreachContextSponsorIsolation(spec)).toThrow(
      OutreachContextSponsorPolicyError,
    );
  });
});
