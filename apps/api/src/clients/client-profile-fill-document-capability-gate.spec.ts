jest.mock('./profile-extraction-context.js',()=>({governProfileExtraction:(_subject:unknown,instructions:string,prompt:string)=>({instructions,prompt})}));
import { BadRequestException } from '@nestjs/common';
import { ClientProfileFillService } from './client-profile-fill.service.js';

/** Typed escape hatch for the private gate under test. */
type Gatherer = (ctx: { tenantId: string; userId: string }, clientId: string, runId: string, attachmentId: string, documentText: string) => Promise<number>;
function gate(service: unknown): Gatherer {
  return (service as unknown as { gatherCapabilityDocument: Gatherer }).gatherCapabilityDocument.bind(service);
}

/**
 * Behavior regression for the document-capability extraction gate
 * (core-open-defects item 4). Not a source-string assertion: these call the
 * real private path with the LLM call stubbed at the boundary and assert on
 * thrown-vs-persisted outcomes.
 *
 *   - malformed non-array `capabilities` → BadRequest (was: normalized to []
 *     and the run completed with zero findings);
 *   - capabilities whose `type` is outside product/service/platform/
 *     program/component → BadRequest when NONE can persist (was: silent continue);
 *   - a genuine empty capabilities array → valid, zero findings, no throw;
 *   - mixed output keeps the valid rows and does not throw.
 */

const clientId = '22222222-2222-4222-8222-222222222222';
const attachmentId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeService(llmText: string) {
  const prisma = {
    withTenant: async (_t: string, run: (tx: unknown) => Promise<unknown>) =>
      run({
        $queryRawUnsafe:async()=>[{id:attachmentId,prospectId:null}],
        engagementAttachment: {
          findFirst: async () => ({ id: attachmentId, fileName: 'cap.docx' }),
        },
      }),
  };
  const credentials = {
    extract: async () => ({data:JSON.parse(llmText),audit:{}}),
  };
  const capabilities = { listCapabilities: async () => [] as Array<{ id: string; name: string }> };
  const service = new ClientProfileFillService(
    prisma as never,
    { get: () => undefined } as never, // config
    credentials as never, // credentials
    {} as never, // sam
    {} as never, // peRelevance
    {} as never, // prepopulation
    {} as never, // clients
    {} as never, // people
    {} as never, // facilities
    capabilities as never, // capabilities
    {} as never, // attachments (EngagementService)
    {} as never, // tracker
  );
  // Stub the extraction boundary: getClientSnapshot + the provider JSON call.
  (service as never as Record<string, unknown>).getClientSnapshot = async () => ({ id: clientId, name: 'Orchid Kite' });
  // addFinding records what would persist.
  const persisted: unknown[] = [];
  (service as never as Record<string, unknown>).addFinding = async (...args: unknown[]) => {
    persisted.push(args);
    return true;
  };
  return { service, persisted };
}

describe('ClientProfileFillService — document capability extraction gate', () => {
  test('throws on a malformed non-array capabilities payload', async () => {
    const { service } = makeService(JSON.stringify({ capabilities: 'not-an-array' }));
    await expect(
      gate(service)({ tenantId: 't', userId: 'u' }, clientId, 'run-1', attachmentId, 'Orchid Kite software platform'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('throws when every extracted capability has an invalid type (silent zero-finding completion removed)', async () => {
    const { service } = makeService(JSON.stringify({
      capabilities: [{ name: 'Orchid Kite', type: 'software platform', description: null, sector: null, tags: [], keywords: [] }],
    }));
    await expect(
      gate(service)({ tenantId: 't', userId: 'u' }, clientId, 'run-1', attachmentId, 'text'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  test('a genuine empty capabilities array completes with zero findings, no throw', async () => {
    const { service, persisted } = makeService(JSON.stringify({ capabilities: [] }));
    expect(await gate(service)({ tenantId: 't', userId: 'u' }, clientId, 'run-1', attachmentId, 'text')).toBe(0);
    expect(persisted).toHaveLength(0);
  });

  test('mixed valid+invalid output rejects BEFORE any addFinding write and persists nothing', async () => {
    const { service, persisted } = makeService(JSON.stringify({
      capabilities: [
        { name: 'Ground robotics platform', type: 'platform', description: null, sector: null, tags: [], keywords: [] },
        { name: 'Bad one', type: 'software platform', description: null, sector: null, tags: [], keywords: [] },
      ],
    }));
    await expect(
      gate(service)({ tenantId: 't', userId: 'u' }, clientId, 'run-1', attachmentId, 'text'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(persisted).toHaveLength(0);
  });

  test('an invalid type cannot update an already-existing capability', async () => {
    const { service, persisted } = makeService(JSON.stringify({
      capabilities: [{ name: 'Ground robotics platform', type: 'software platform', description: null, sector: null, tags: [], keywords: [] }],
    }));
    // Injected capabilities stub returns no existing rows; re-stub with the
    // duplicate present.
    const caps = (service as never as { capabilities: unknown }).capabilities as {
      listCapabilities: () => Promise<Array<{ id: string; name: string }>>;
    };
    caps.listCapabilities = async () => [{ id: 'existing', name: 'Ground robotics platform' }];
    await expect(gate(service)({ tenantId: 't', userId: 'u' }, clientId, 'run-1', attachmentId, 'text')).rejects.toBeInstanceOf(BadRequestException);
    expect(persisted).toHaveLength(0);
  });
});

test('keeps actual document support and lifecycle on a valid capability proposal',async()=>{
 const {service,persisted}=makeService(JSON.stringify({capabilities:[{name:'Planned system',type:'program',lifecycle:'planned',description:'A planned system',sector:null,tags:[],keywords:[]}]}));
 await gate(service)({tenantId:'t',userId:'u'},clientId,'run-1',attachmentId,'The company announced Planned system for development.');
 expect(persisted).toHaveLength(1);
 expect((persisted[0] as unknown[])[3]).toMatchObject({proposedValue:{lifecycle:'planned'},evidence:[expect.objectContaining({excerpt:'The company announced Planned system for development.'})]});
});

 test('existing capability document stages a version-bound update instead of dropping its name',async()=>{
 const {service,persisted}=makeService(JSON.stringify({capabilities:[{name:'Ground robotics platform',type:'platform',lifecycle:'in_service',description:'Improved source description',sector:null,tags:[],keywords:[]}]}));
 (service as unknown as {capabilities:{listCapabilities:()=>Promise<unknown[]>}}).capabilities.listCapabilities=async()=>[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'Ground robotics platform',version:4}];
 await gate(service)({tenantId:'t',userId:'u'},clientId,'run-1',attachmentId,'Ground robotics platform has improved sensors.');
 expect(persisted).toHaveLength(1);
 expect((persisted[0] as unknown[])[3]).toMatchObject({proposedValue:{capabilityId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedCapabilityVersion:4,description:'Improved source description'}});
 });
