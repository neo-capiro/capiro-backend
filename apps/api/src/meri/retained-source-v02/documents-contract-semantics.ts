// Semantic port of Meri retrieval-0.2/client-documents-validation.mjs, including explicit General client selectors.
// Pure private client document list/read contract, independently described from
// pinned producer projections. No byte reader, extractor, provider, grant or
// cursor-signing service. A supplied binding, cursor or hash proves no access.
import {createHash} from 'node:crypto';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
// Schema-derived values are dynamic JSON only after their full pinned shape.
type JsonObject = Record<string, any>;
const snapshotOperationData = (value: unknown): JsonObject => JSON.parse(canonicalizeCoreRetainedJson(value));

function fail(message: string): never { throw new Error(message); }
const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const integer = (value: number, minimum: number, maximum=Number.MAX_SAFE_INTEGER) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const stamp = (value: string | null) => { if (value !== null && !Number.isFinite(Date.parse(value))) fail('Document timestamp is not finite'); };
function optionalText(input: JsonObject, key: string, maximum: number) {
  if (input[key] === undefined) return null;
  const value=input[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) fail(`Invalid document ${key}`);
  return value.trim();
}

export function createClientDocumentsValidators({validateShape, assertSubject, canonicalSha256}: {
  validateShape: (name: string, value: unknown) => void;
  assertSubject: (subject: JsonObject, binding: JsonObject) => void;
  canonicalSha256: (value: unknown) => string;
}) {
  function context(raw: unknown) {
    const value=snapshotOperationData(raw);
    validateShape('ClientDocumentsContext',value);assertSubject(value.subject,value.binding);
    if (!['client','personal'].includes(value.subject.kind)) fail('One current client or personal subject required');
    return value;
  }
  function cursor(value: string, clientId: string, documentId: string, query: string) {
    if (!value.startsWith('document:') || !/^[A-Za-z0-9_-]+$/.test(value.slice(9))) fail('Invalid document cursor');
    let parsed;
    try { parsed=snapshotOperationData(JSON.parse(Buffer.from(value.slice(9),'base64url').toString('utf8'))); }
    catch { fail('Invalid document cursor JSON'); }
    validateShape('ClientDocumentCursor',parsed);
    if (parsed.clientId !== clientId || parsed.documentId !== documentId || parsed.query !== query)
      fail('Document cursor client/document/query changed');
    return parsed;
  }
  function normalizeClientDocumentsInput(raw: unknown, options: unknown={}) {
    const input=snapshotOperationData(raw), ctx=context(options);
    validateShape('ClientDocumentsInput',input);
    const clientId=optionalText(input,'clientId',80);
    if (clientId === null) fail('Explicit document client selector required');
    if (ctx.subject.kind === 'personal' ? !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(clientId ?? '') :
        clientId === null || clientId !== ctx.subject.entityIds[0]) fail('Document client selector differs from current subject');
    const documentId=optionalText(input,'documentId',80), query=optionalText(input,'query',240) ?? '';
    const token=optionalText(input,'cursor',4096), mode=documentId===null?'list':'read';
    const limit=input.limit ?? (documentId===null?25:5000);
    if (!integer(limit,1,documentId===null?50:6000)) fail('Document limit outside selected mode');
    let section=input.section ?? 1, characterOffset=input.characterOffset ?? 0;
    let cursorBinding: JsonObject | null=null, listAfter: string | null=null;
    if (token !== null) {
      if (input.section !== undefined || input.characterOffset !== undefined) fail('Document cursor conflicts with explicit range');
      if (documentId===null) {
        if (!/^documents:[A-Za-z0-9-]{1,80}$/.test(token)) fail('Invalid document-list cursor');
        listAfter=token.slice(10);
      } else {
        cursorBinding=cursor(token,clientId,documentId,query);
        section=cursorBinding.section;characterOffset=cursorBinding.offset;
      }
    }
    if (!integer(section,1) || !integer(characterOffset,0)) fail('Invalid document section/range');
    if (documentId===null && (input.section !== undefined || input.characterOffset !== undefined))
      fail('Document section requires document identity');
    const result={mode,clientId,documentId,query,section,characterOffset,limit,cursor:token,cursorBinding,listAfter};
    validateShape('ClientDocumentsSelection',result);return result;
  }
  function list(data: JsonObject, input: JsonObject) {
    validateShape('ClientDocumentsListData',data);
    const c=data.coverage, rows=data.documents;
    if (c.query !== (input.query || null) || c.returned !== rows.length || rows.length>input.limit || c.total<rows.length)
      fail('Document listing count/query mismatch');
    if (c.truncated !== (c.nextCursor!==null) || c.paginationComplete !== !c.truncated ||
        c.complete !== (input.listAfter===null && !c.truncated)) fail('Document listing completeness mismatch');
    if (c.nextCursor!==null && (rows.length!==input.limit || c.nextCursor!==`documents:${rows.at(-1).id}` || c.total<=rows.length))
      fail('Document listing continuation must follow a full page');
    if (input.listAfter===null && !c.truncated && c.total!==rows.length) fail('Document listing first page total mismatch');
    let previous=input.listAfter;
    for(const row of rows) {
      if (previous!==null && row.id<=previous) fail('Document list must advance by identity');
      previous=row.id;
      if (input.query && !row.fileName.toLowerCase().includes(input.query.toLowerCase())) fail('Document filename query mismatch');
      stamp(row.createdAt);stamp(row.indexedAt);
      if (row.usable !== (row.blockedReason===null)) fail('Document readiness/blocked reason mismatch');
    }
  }
  function read(data: JsonObject, input: JsonObject) {
    validateShape('ClientDocumentsReadData',data);
    const c=data.coverage, doc=data.document, row=data.records[0];
    if (doc.id!==input.documentId || c.query!==(input.query||null)) fail('Document read identity/query mismatch');
    // Audio transcripts are a single document section even when an explicit
    // source section was requested. No other source can silently substitute it.
    if (c.section!==input.section && !(row?.payload.source==='transcription' && c.section===1 && c.sectionCount===1))
      fail('Document read section changed');
    if (c.section>c.sectionCount || c.characterStart<input.characterOffset ||
        c.characterEnd<c.characterStart || c.characterEnd>c.sectionCharacters)
      fail('Document UTF-16 range mismatch');
    if (!input.query && c.characterStart!==input.characterOffset) fail('Document full read skipped text');
    if (input.query ? typeof c.matched!=='boolean' : c.matched!==null) fail('Document match disclosure mismatch');
    if (c.matched===false && (c.characterStart!==c.sectionCharacters || c.characterEnd!==c.sectionCharacters || row))
      fail('Document no-match page contains a match');
    if (c.matched===true && (!row || !row.payload.text.toLowerCase().includes(input.query.toLowerCase())))
      fail('Document reported match requires the query in returned evidence');
    if (input.cursorBinding && input.cursorBinding.contentHash!==doc.contentHash) fail('Document content changed during continuation');
    const moreText=c.characterEnd<c.sectionCharacters, moreSections=c.section<c.sectionCount;
    if (c.continuationBlocked) {
      if (!c.extractedSectionEmpty || row || c.nextCursor!==null || c.missingContent!==true ||
          typeof c.nextAction!=='string' || !c.nextAction.trim() || c.explicitNextSection!==(moreSections?c.section+1:null))
        fail('Unreadable document page must block automatic continuation');
    } else if (['missingContent','nextAction','explicitNextSection'].some(key=>Object.hasOwn(c,key)))
      fail('Unexpected blocked-page disclosure');
    if ((c.nextCursor!==null)!==(!c.continuationBlocked && (moreText||moreSections))) fail('Document continuation missing or invented');
    if (c.truncated!==(c.nextCursor!==null || c.extractionTruncated || c.continuationBlocked)) fail('Document truncation mismatch');
    const complete=!input.query && c.characterStart===0 && c.section===1 && c.sectionCount===1 &&
      c.nextCursor===null && !c.extractedSectionEmpty && !c.extractionTruncated;
    if (c.complete!==complete || c.sectionComplete!==(c.characterStart===0 && !moreText && !c.continuationBlocked && !c.extractionTruncated))
      fail('Document completeness exceeds the declared extraction/range');
    if (c.extractedSectionEmpty && (row || c.matched===true)) fail('Empty extraction contains evidence');
    if (row) {
      const p=row.payload, v=row.provenance;
      const reference=`${doc.id}:${doc.contentHash.slice(0,16)}:${c.section}:${c.characterStart}-${c.characterEnd}`;
      if (!p.text.trim() || p.text.length!==c.characterEnd-c.characterStart || p.text.length>6000 ||
          JSON.stringify(p.text).length>6500) fail('Document text UTF-16/serialized range mismatch');
      if (p.text.length>Math.max(input.limit,input.query?input.query.length+240:0)) fail('Document excerpt exceeds selected bound');
      if (row.recordId!==reference || p.id!==reference || p.documentId!==doc.id || p.fileName!==doc.fileName ||
          p.title!==doc.fileName || p.contentType!==doc.contentType || v.sourceRecordId!==doc.id ||
          v.clientId!==input.clientId || v.contentHash!==doc.contentHash)
        fail('Document record identity/provenance mismatch');
      for(const key of ['section','characterStart','characterEnd']) if(p[key]!==c[key] || v[key]!==c[key])
        fail('Document record range differs from coverage');
      if ((p.rowStart===undefined)!==(p.rowEnd===undefined) || (p.rowStart!==undefined &&
          (p.sectionKind!=='sheet_rows' || p.rowEnd<p.rowStart))) fail('Document row provenance mismatch');
      if (input.cursorBinding?.sectionHash && input.cursorBinding.sectionHash!==v.sectionHash)
        fail('Document section extraction changed during continuation');
      if (c.characterStart===0 && c.characterEnd===c.sectionCharacters && digest(p.text)!==v.sectionHash)
        fail('Complete returned section hash mismatch');
    } else if (!c.extractedSectionEmpty && c.characterEnd>c.characterStart && c.characterStart===0 && c.characterEnd===c.sectionCharacters)
      fail('Nonempty complete section omitted its evidence record');
    if (c.nextCursor!==null) {
      const next=cursor(c.nextCursor,input.clientId,doc.id,input.query);
      if (next.contentHash!==doc.contentHash || next.section!==(moreText?c.section:c.section+1) ||
          next.offset!==(moreText?c.characterEnd:0) ||
          (moreText ? next.sectionHash===undefined || (row && next.sectionHash!==row.provenance.sectionHash)
            : next.sectionHash!==undefined) || c.nextCursor===input.cursor)
        fail('Document continuation content/range/hash mismatch');
    }
    const r=c.readability;
    if (c.contentScope!==(r?.method==='openai_pdf'?'provider_transcribed_page_text':'extractable_text_only'))
      fail('Document extraction method disclosure mismatch');
    if (r) {
      if(r.section!==c.section || r.sectionCount!==c.sectionCount || r.chars!==c.sectionCharacters)
        fail('Document readability range mismatch');
      if(r.status==='ocr_partial' && !c.extractionTruncated) fail('Partial OCR cannot claim full extraction');
      if(['ocr_unavailable','no_readable_text'].includes(r.status) && !c.extractedSectionEmpty)
        fail('Unreadable extraction cannot contain readable evidence');
      if(['text_readable','ocr_readable','ocr_partial'].includes(r.status) && c.extractedSectionEmpty)
        fail('Readable extraction cannot claim an empty section');
      if(r.method==='openai_pdf' && row && row.payload.source!=='pdf') fail('PDF visual method requires a PDF source');
      if(r.status==='text_readable' && r.method!=='text') fail('Text readability method mismatch');
      if(r.status.startsWith('ocr_') && r.method!=='openai_pdf') fail('OCR readability method mismatch');
    }
    const m=c.extractionMetadata;
    if(m && typeof m==='object' && !Array.isArray(m) && m.sectionRead===true) {
      if(m.chars!==c.sectionCharacters || m.section!==c.section || m.sectionCount!==c.sectionCount ||
          m.truncated!==c.extractionTruncated || m.emptySection!==c.extractedSectionEmpty ||
          canonicalSha256(m.readability)!==canonicalSha256(r)) fail('Document section extraction metadata mismatch');
    }
  }
  function assertClientDocumentsResult(raw: unknown, request: unknown, options: unknown={}) {
    const input=normalizeClientDocumentsInput(request,options), ctx=context(options), page=snapshotOperationData(raw);
    validateShape('ClientDocumentsResult',page);assertSubject(page.subject,page.binding);
    if(canonicalSha256(page.binding)!==canonicalSha256(ctx.binding) || canonicalSha256(page.subject)!==canonicalSha256(ctx.subject) ||
        page.data.clientId!==input.clientId) fail('Document result lineage mismatch');
    stamp(page.data.generatedAt);
    if(input.mode==='list') list(page.data,input); else read(page.data,input);
    // Returned claims remain reported source data. Neither a complete extraction
    // nor a valid wrapper proves current access, visual coverage or absence.
    return page;
  }
  return {normalizeClientDocumentsInput,assertClientDocumentsResult};
}
