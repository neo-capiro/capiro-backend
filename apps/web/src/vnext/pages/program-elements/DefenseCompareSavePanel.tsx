import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { DefenseComparisonResponseDto, DefenseSavedComparisonDto, SaveDefenseComparisonDto, DefenseSavedComparisonBasisDto } from '@capiro/shared';
import { useApi } from '../../../lib/use-api.js';
import { listSavedDefenseComparisons, saveDefenseComparison } from './defense-research-api.js';

const emptyBasis = (): DefenseSavedComparisonBasisDto => ({requestEdition:null,fundingFiscalYear:null,stage:null,metric:null,unit:null,currency:null,priceBasis:null,asOfDate:null,periodStart:null,periodEnd:null});
export function savedBasisFromMetricKey(key: string): DefenseSavedComparisonBasisDto {
  if (!key) return emptyBasis();
  const parts=key.split('|');
  if(parts.length!==7||!/^\d{4}$/.test(parts[1]??''))return emptyBasis();
  const [edition,fy,stage,metric,unit,currency,priceBasis] = parts as [string,string,string,string,string,string,string];
  return {...emptyBasis(),requestEdition:edition === 'unknown-edition' ? null : edition,fundingFiscalYear:Number(fy),stage,metric,unit,currency:currency === 'unknown-currency' ? null : currency,priceBasis:priceBasis === 'unknown-price-basis' ? null : priceBasis};
}
type PendingCapture = { authorityKey: string; id?: string; input: SaveDefenseComparisonDto; uncertain: boolean; inFlight: boolean; rejected?: boolean; resolved?: boolean };
function readPendingCapture(storageKey: string, authorityKey: string): { operation: PendingCapture | null; error: string } {
  try {
    const stored = localStorage.getItem(storageKey);
    if (!stored) return {operation:null,error:''};
    const parsed = JSON.parse(stored) as PendingCapture;
    if (parsed.authorityKey !== authorityKey || parsed.input?.schemaVersion !== 'defense_saved_comparison_v1' || typeof parsed.input.idempotencyKey !== 'string' || typeof parsed.input.name !== 'string' || !Array.isArray(parsed.input.subjects) || parsed.input.selection?.mode !== 'explicit' || !Array.isArray(parsed.input.selection.subjectKeys) || !Array.isArray(parsed.input.selection.passageIds) || !parsed.input.basisPair?.left || !parsed.input.basisPair?.right || !Array.isArray(parsed.input.contextualRevisionPins)) return {operation:null,error:'The saved operation recovery record is invalid. Restore this browser record before continuing.'};
    if(parsed.resolved)return {operation:null,error:''};
    // A remount cannot know whether an interrupted request committed.
    return {operation:{...parsed,uncertain:parsed.uncertain !== false || parsed.inFlight === true,inFlight:false},error:''};
  } catch { return {operation:null,error:'Saved operation recovery storage could not be read. No new save will be sent.'}; }
}
export function DefenseCompareSavePanel({comparison,saved,onLoad,onEdit,authority,onPendingChange,externalLocked=false}: {
  comparison?: DefenseComparisonResponseDto; saved?: DefenseSavedComparisonDto;
  onLoad:(id:string)=>void; onEdit:()=>void;
  authority: readonly [string | null,string | null,string | null];
  onPendingChange?: (pending:boolean)=>void; externalLocked?:boolean;
}) {
  const api=useApi();
  const authorityKey=JSON.stringify(authority);
  const storageKey='capiro:defense-compare-pending:v1:'+authorityKey;
  const mounted=useRef(true);
  const currentAuthority=useRef(authorityKey);
  currentAuthority.current=authorityKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [name,setName]=useState('');
  const [includeArchived,setIncludeArchived]=useState(false);
  const [selection,setSelection]=useState<readonly string[]>([]);
  const [passages,setPassages]=useState<readonly string[]>([]);
  const [left,setLeft]=useState(''); const [right,setRight]=useState('');
  const [draftBasis,setDraftBasis]=useState<SaveDefenseComparisonDto['basisPair']|null>(null);
  const [editing,setEditing]=useState<DefenseSavedComparisonDto|null>(null);
  const [saveError,setSaveError]=useState('');
  const [recovery,setRecovery]=useState(()=>readPendingCapture(storageKey,authorityKey));
  const activeAttempt=useRef<PendingCapture|null>(null);
  const pending=recovery.operation?.rejected ? null : recovery.operation;
  const ownLocked=!!pending || !!recovery.error;
  const locked=ownLocked||externalLocked;
  const list=useQuery({queryKey:['defense-saved-comparisons',...authority,includeArchived],queryFn:()=>listSavedDefenseComparisons(api,includeArchived),enabled:!!authority[0]});
  useEffect(()=>{onPendingChange?.(ownLocked);},[ownLocked,onPendingChange]);
  useEffect(()=>{
    if(!recovery.operation)return;
    const input=recovery.operation.input;
    setName(input.name);setSelection(input.selection.subjectKeys);setPassages(input.selection.passageIds);setDraftBasis(input.basisPair);
  },[recovery.operation]);
  useEffect(()=>{
    if(!saved||locked)return;
    setEditing(saved);
    if(recovery.operation?.rejected)return;
    setName(saved.name);setSelection(saved.currentVersion.selection.subjectKeys);setPassages(saved.currentVersion.selection.passageIds);setDraftBasis(saved.currentVersion.basisPair);
    setLeft('');setRight('');setSaveError('');
  },[saved,locked]);
  const changeBasis=(side:'left'|'right',value:string)=>{
    if(side==='left')setLeft(value);else setRight(value);
    setDraftBasis(current=>({...current ?? {left:emptyBasis(),right:emptyBasis()},[side]:savedBasisFromMetricKey(value)}));
  };
  const toggle=(values:readonly string[],id:string)=>values.includes(id)?values.filter(value=>value!==id):[...values,id];
  const mutation=useMutation({mutationFn:async (revise:boolean)=>{
    if(!authority[0]||recovery.error)throw new Error('Authenticated recovery authority is required.');
    // Recovery is always user initiated and sends the original payload and key.
    // Rendering/remounting never calls this mutation.
    if(pending){
      if(pending.authorityKey!==authorityKey)throw new Error('Original saved operation belongs to another authority.');
      const attempt={...pending,inFlight:true};localStorage.setItem(storageKey,JSON.stringify(attempt));activeAttempt.current=attempt;setRecovery({operation:attempt,error:''});
      return saveDefenseComparison(api,pending.input,pending.id);
    }
    activeAttempt.current=null;
    if(externalLocked)throw new Error('Recover the original saved action before starting another save.');
    if(!comparison)throw new Error('Load a comparison before saving.');
    const subjects=saved?.currentVersion.subjects ?? comparison.subjects.map(({type,id})=>({type,id}));
    // Pinned saved values are immutable; revision capture is explicit through Edit.
    if(saved)throw new Error('Choose Edit subjects before capturing a new version.');
    const contextSubjects=subjects.filter(subject=>subject.type==='context_document');
    const contextualRevisionPins=contextSubjects.map(subject=>{
      const evidence=comparison.metrics.flatMap(metric=>metric.cells.filter(cell=>cell.subjectKey==='context_document:'+subject.id).flatMap(cell=>[...cell.evidence])).filter(e=>e.evidenceRefId.startsWith('context-compare:'));
      const revisionIds=[...new Set(evidence.map(e=>e.sourceRevisionId).filter((id):id is string=>!!id))];
      if(revisionIds.length!==1)throw new Error('A contextual subject needs one qualified exact revision before saving.');
      return {documentId:subject.id,revisionId:revisionIds[0]!,sectionIds:[...new Set(evidence.map(e=>e.evidenceRefId.slice('context-compare:'.length)))]};
    });
    if(selection.some(key=>!subjects.some(subject=>subject.type+':'+subject.id===key))||passages.some(id=>!contextualRevisionPins.some(pin=>pin.sectionIds.includes(id))))throw new Error('The explicit selection changed with the subjects or source revision. Choose the selection again before saving.');
    const selectedKeys=selection;
    const selectedPassages=passages;
    const draft={schemaVersion:'defense_saved_comparison_v1' as const,displayVersion:'defense-compare-display-v1' as const,name,subjects,selection:{mode:'explicit' as const,subjectKeys:selectedKeys,passageIds:selectedPassages},basisPair:draftBasis ?? {left:savedBasisFromMetricKey(left),right:savedBasisFromMetricKey(right)},passageMode:selectedPassages.length?'native_sections' as const:'none' as const,contextualRevisionPins,...(revise && editing ? {expectedRevision:editing.revision,portfolioId:editing.portfolioId}: {})};
    const input:SaveDefenseComparisonDto={...draft,idempotencyKey:crypto.randomUUID()};
    const operation:PendingCapture={authorityKey,input,uncertain:false,inFlight:true,...(revise?{id:editing?.id}: {})};
    // Durable recovery must succeed BEFORE POST; failure prevents the write.
    localStorage.setItem(storageKey,JSON.stringify(operation));
    activeAttempt.current=operation;
    setRecovery({operation,error:''});
    return saveDefenseComparison(api,input,revise?editing?.id:undefined);
  },onSuccess:result=>{
    try{localStorage.removeItem(storageKey);}catch{try{localStorage.setItem(storageKey,JSON.stringify({...activeAttempt.current,resolved:true,inFlight:false}));}catch{/* The server already confirmed success; cleanup cannot change that outcome. */}}
    activeAttempt.current=null;
    if(!mounted.current||currentAuthority.current!==authorityKey)return;
    setRecovery({operation:null,error:''});onPendingChange?.(false);setEditing(result.comparison);onLoad(result.comparison.id);void list.refetch();setSaveError('');
  },onError:error=>{
    const attempt=activeAttempt.current;
    const status=(error as {response?:{status?:number}}).response?.status;
    const definitive=typeof status==='number'&&status>=400&&status<500&&status!==408&&status!==429;
    if(!attempt){if(mounted.current&&currentAuthority.current===authorityKey)setSaveError('No save was sent. Check the draft and recovery storage, then try again.');return;}
    const unlock=definitive&&!attempt.uncertain;
    const operation={...attempt,inFlight:false,uncertain:!unlock,rejected:unlock};
    try{localStorage.setItem(storageKey,JSON.stringify(operation));}catch{/* Earlier in-flight durable record remains conservative on remount. */}
    activeAttempt.current=null;
    if(!mounted.current||currentAuthority.current!==authorityKey)return;
    setRecovery({operation,error:''});onPendingChange?.(!unlock);
    setSaveError(unlock?'The save was rejected. Your draft is retained; edit it or reload the current saved version before saving again.':'The save result is uncertain. Retry the original saved operation to recover its result before editing.');
  }});
  const basisOptions=comparison?.metrics.filter(metric=>metric.metric!=='passage') ?? [];
  const passageOptions=[...new Map((comparison?.metrics.filter(metric=>metric.metric==='passage') ?? []).flatMap(metric=>metric.cells.flatMap(cell=>cell.evidence.filter(e=>e.evidenceRefId.startsWith('context-compare:')).map(e=>[e.evidenceRefId.slice('context-compare:'.length),metric.label] as const)))).entries()];
  return <section className="dr-section" aria-label="Saved comparisons">
    <h2>Saved comparisons</h2>
    <label><input type="checkbox" aria-label="Include archived saved comparisons" disabled={locked||!authority[0]} checked={includeArchived} onChange={event=>setIncludeArchived(event.target.checked)}/>Include archived saved comparisons</label>
    <label>Open saved comparison <select aria-label="Open saved comparison" disabled={locked||!authority[0]} value={saved?.id ?? ''} onChange={e=>e.target.value&&onLoad(e.target.value)}><option value="">Choose a comparison</option>{list.data?.map(item=><option key={item.id} value={item.id}>{item.name}{item.archivedAt?' (archived)':''}</option>)}</select></label>
    {list.isError?<p role="alert">Saved comparisons could not be loaded.</p>:null}
    {saved?<><p>Captured {saved.currentVersion.capturedAt} · version {saved.currentVersion.version}. This view shows the saved capture.</p><button type="button" disabled={locked||!!saved.archivedAt} onClick={onEdit}>Edit subjects and capture a new version</button></>:<>
      <label>Comparison name <input aria-label="Comparison name" disabled={locked||!authority[0]} maxLength={200} value={name} onChange={e=>setName(e.target.value)}/></label>
      <fieldset disabled={locked||!authority[0]}><legend>Selected subjects</legend>{comparison?.subjects.map(subject=><label key={subject.key}><input type="checkbox" checked={selection.includes(subject.key)} onChange={()=>setSelection(toggle(selection,subject.key))}/>{subject.label}</label>)}</fieldset>
      <p>An empty selection saves an empty display.</p>
      <fieldset disabled={locked||!authority[0]}><legend>Funding bases</legend>{(['left','right'] as const).map(side=><label key={side}>{side==='left'?'Left':'Right'} basis <select aria-label={side+' basis'} value={side==='left'?left:right} onChange={e=>changeBasis(side,e.target.value)}><option value="">Unspecified / unsupported</option>{basisOptions.map(metric=><option key={metric.key} value={metric.key}>{metric.key}</option>)}</select></label>)}{draftBasis?<small>Both saved bases are preserved until explicitly changed.</small>:null}</fieldset>
      {passageOptions.length?<fieldset disabled={locked||!authority[0]}><legend>Selected source passages</legend>{passageOptions.map(([id,label])=><label key={id}><input type="checkbox" checked={passages.includes(id)} onChange={()=>setPassages(toggle(passages,id))}/>{label}</label>)}</fieldset>:null}
      <button type="button" disabled={!comparison||!name.trim()||mutation.isPending||locked||!authority[0]} onClick={()=>mutation.mutate(false)}>Save new comparison</button>
      {editing?<button type="button" disabled={!comparison||!name.trim()||mutation.isPending||locked||!authority[0]} onClick={()=>mutation.mutate(true)}>Save new version</button>:null}
    </>}
    {mutation.isPending?<p role="status">Saving comparison…</p>:null}{saveError?<p role="alert">{saveError}</p>:null}
    {pending?<><p role="status">An earlier save needs recovery. Its original request is retained; edits are frozen until the result is recovered.</p><button type="button" disabled={mutation.isPending} onClick={()=>mutation.mutate(false)}>Retry original saved operation</button></>:null}
    {recovery.error?<p role="alert">{recovery.error}</p>:null}
    {recovery.operation?.rejected&&recovery.operation.id?<button type="button" onClick={()=>onLoad(recovery.operation!.id!)}>Reload current saved capture</button>:null}
  </section>;
}
