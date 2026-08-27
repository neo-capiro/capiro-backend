import { communityFundingIdentity } from './community-funding.identity.js';
import type { FundingCandidate } from './community-funding.types.js';
const base: FundingCandidate = { chamber:'house',requestType:'cpf',fiscalYear:2026,requesterName:'Jane Smith',requesterState:null,requesterDistrict:null,recipientName:'Acme, Inc.',recipientAddress:null,city:null,state:null,zip:null,projectTitle:'Water Plant',projectDescription:null,requestedAmountUsd:'10.00',finalAmountUsd:null,amountStageRaw:'amount_requested',appropriationsAccountRaw:'Account',subcommittee:null,sourcePage:null,sourceRow:2 };
describe('community funding identity', () => {
  it('is stable across non-identity changes and normalization', () => {
    expect(communityFundingIdentity(base,'00000000-0000-0000-0000-000000000001')).toBe(communityFundingIdentity({...base,recipientName:'ACME INC',requestedAmountUsd:'20.00'},'00000000-0000-0000-0000-000000000001'));
  });
  it('distinguishes fiscal year, chamber and source documents', () => {
    const one=communityFundingIdentity(base,'00000000-0000-0000-0000-000000000001');
    expect(communityFundingIdentity({...base,fiscalYear:2027},'00000000-0000-0000-0000-000000000001')).not.toBe(one);
    expect(communityFundingIdentity({...base,chamber:'senate',requestType:'cds'},'00000000-0000-0000-0000-000000000001')).not.toBe(one);
    expect(communityFundingIdentity(base,'00000000-0000-0000-0000-000000000002')).not.toBe(one);
  });
});
