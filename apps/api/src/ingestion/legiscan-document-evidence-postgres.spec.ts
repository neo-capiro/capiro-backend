import {createHash,randomUUID} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {documentEvidence,persistDocumentEvidence} from './legiscan-document-evidence.js';
import type {LegiscanDocument} from '../external/legiscan/legiscan.client.js';
describe('immutable document bytes and source observations on PostgreSQL',()=>{
  jest.setTimeout(30000);const p=new PrismaClient(),billKey='fl-2097-doc-'+randomUUID(),providerId=Math.floor(Math.random()*100000000)+600000000;
  const doc=(body:string):LegiscanDocument=>({doc_id:providerId,bill_id:providerId,type:'Supplement',document_kind:'supplement',mime:'text/plain',doc:Buffer.from(body).toString('base64'),text_size:Buffer.byteLength(body),text_hash:createHash('md5').update(body).digest('hex'),date:'2097-01-02',title:'Synthetic evidence',state_link:'https://example.gov/same-source.txt'});
  const stub={id:providerId,billId:providerId,kind:'supplement' as const};
  beforeAll(async()=>{if(process.env.LEGIWATCH_PHASE5_TEST_DATABASE!=='disposable'||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL!).hostname))throw Error('Disposable DB required');await p.$executeRaw`INSERT INTO state_bill(id,state,session,session_key,identifier,bill_number,title,legiscan_bill_id) VALUES(${billKey},'FL','2097','2097','HB 1','hb1','Synthetic document',${providerId})`;});
  afterAll(async()=>{await p.$disconnect();});
  it('retains corrected bytes at the same URL and a later restoration without duplicating content',async()=>{
    const first=doc('Original public text.'),second=doc('Corrected public text.');
    await persistDocumentEvidence(p,billKey,first,stub);await persistDocumentEvidence(p,billKey,second,stub);await persistDocumentEvidence(p,billKey,second,stub);await persistDocumentEvidence(p,billKey,first,stub);
    const rows=await p.stateBillPublishedRecord.findMany({where:{billKey,kind:'document'},orderBy:{firstObservedAt:'asc'}});expect(rows).toHaveLength(2);
    expect(rows.map(r=>(r.evidence as {contentSnapshotBase64:string}).contentSnapshotBase64)).toEqual([first.doc,second.doc]);
    const trail=await p.$queryRaw<Array<{state_record_id:string}>>`SELECT state_record_id FROM published_record_source_observation WHERE source_key=${`state:${billKey}:document:legiscan:supplement:${providerId}`} ORDER BY id`;
    expect(trail.map(r=>r.state_record_id)).toEqual([rows[0]!.id,rows[1]!.id,rows[0]!.id]);
    expect((rows[0]!.evidence as {parserVersion:string}).parserVersion).toBe('utf8-normalized-character-locators-v1');
  });
  it('rejects wrong bill, unqualified document identity, invalid provider hash and unreadable text encoding',async()=>{
    await expect(persistDocumentEvidence(p,billKey,{...doc('Wrong'),bill_id:providerId+1},stub)).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    await expect(persistDocumentEvidence(p,billKey,doc('Wrong'),{...stub,id:providerId+1})).rejects.toThrow('DOCUMENT_SUBJECT_MISMATCH');
    await expect(persistDocumentEvidence(p,billKey,{...doc('Wrong'),text_hash:'0'.repeat(32)},stub)).rejects.toThrow('DOCUMENT_PROVIDER_HASH_MISMATCH');
    await expect(documentEvidence(doc('\uFFFD'),{billId:providerId,docId:providerId})).rejects.toThrow('DOCUMENT_TEXT_ENCODING_UNQUALIFIED');
    expect(await p.stateBillPublishedRecord.count({where:{billKey}})).toBe(2);
  });
  it('labels unavailable content and blank text without claiming usable evidence',async()=>{
    const binary=await documentEvidence({...doc('Unreadable binary'),mime:'application/octet-stream'},{billId:providerId,docId:providerId});expect(binary.evidence).toMatchObject({extractionState:'unreadable',coverage:'unknown',sections:[]});
    const blank=await documentEvidence(doc('   '),{billId:providerId,docId:providerId});expect(blank.evidence.extractionState).toBe('unreadable');
  });
});
