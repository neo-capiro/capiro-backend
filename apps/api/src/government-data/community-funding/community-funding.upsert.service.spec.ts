import { CommunityFundingUpsertService } from './community-funding.upsert.service.js';
import type { FundingCandidate } from './community-funding.types.js';

const candidate: FundingCandidate = { chamber:'house',requestType:'cpf',fiscalYear:2026,requesterName:'Jane Smith',requesterState:null,
  requesterDistrict:'01',recipientName:'Acme',recipientAddress:'1 Main St',city:'Austin',state:'TX',zip:null,projectTitle:'Water',
  projectDescription:null,requestedAmountUsd:'100.00',finalAmountUsd:null,amountStageRaw:'amount_requested',appropriationsAccountRaw:null,
  subcommittee:'THUD',sourcePage:null,sourceRow:2 };

describe('CommunityFundingUpsertService', () => {
  it('uses one real transaction, persists provenance, and is idempotent', async () => {
    const stored = new Map<string, { sourceHash: string | null; data: Record<string, unknown> }>();
    const delegate = {
      findUnique: jest.fn(async ({where}:{where:{identityHash:string}}) => stored.get(where.identityHash) ?? null),
      upsert: jest.fn(async ({where,create,update}:{where:{identityHash:string};create:Record<string,unknown>;update:Record<string,unknown>}) => {
        stored.set(where.identityHash, { sourceHash: String((stored.has(where.identityHash) ? update : create).sourceHash), data: stored.has(where.identityHash) ? update : create });
      }),
    };
    const prisma = { $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn({ communityFundingRequest: delegate })) };
    const service = new CommunityFundingUpsertService(prisma as never), doc='00000000-0000-0000-0000-000000000001';
    expect(await service.upsertMany([candidate], doc)).toEqual({ upserted:1, changed:0, unchanged:0 });
    expect(await service.upsertMany([candidate], doc)).toEqual({ upserted:0, changed:0, unchanged:1 });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect([...stored.values()][0]!.data).toMatchObject({ sourceDocumentId:doc, sourceRow:2, finalAmountUsd:null, recipientNormalized:'ACME' });
  });
  it('updates a non-identity correction but creates a distinct identity for title changes', async () => {
    const hashes = new Map<string,string>();
    const tx = { communityFundingRequest: { findUnique: async ({where}:{where:{identityHash:string}}) => hashes.has(where.identityHash) ? {sourceHash:hashes.get(where.identityHash)} : null,
      upsert: async ({where,create}:{where:{identityHash:string};create:{sourceHash:string}}) => { hashes.set(where.identityHash,create.sourceHash); } } };
    const service = new CommunityFundingUpsertService({$transaction:(fn:(v:unknown)=>unknown)=>fn(tx)} as never);
    const doc='00000000-0000-0000-0000-000000000001';
    await service.upsertMany([candidate],doc);
    expect(await service.upsertMany([{...candidate,requestedAmountUsd:'125.00'}],doc)).toMatchObject({changed:1});
    await service.upsertMany([{...candidate,projectTitle:'Different'}],doc);
    expect(hashes.size).toBe(2);
  });
});
