import {useEffect,useRef,useState} from 'react';
import {useMutation,useQuery,useQueryClient} from '@tanstack/react-query';
import type {AddDefenseSavedComparisonSelectionDto,ChangeDefenseSavedComparisonLifecycleDto,DefenseSavedComparisonDto} from '@capiro/shared';
import {useApi} from '../../../lib/use-api.js';
import {addSavedDefenseComparisonSelection,changeSavedDefenseComparisonLifecycle} from './defense-research-api.js';
import {getResearchPortfolio,listResearchPortfolios} from '../research-portfolios/research-portfolios-api.js';

type Action = {kind:'archive'|'restore';id:string;input:ChangeDefenseSavedComparisonLifecycleDto}|{kind:'selection';id:string;versionId:string;input:AddDefenseSavedComparisonSelectionDto};
type Pending = {authorityKey:string;action:Action;uncertain:boolean;inFlight:boolean;rejected?:boolean;resolved?:boolean};
function readRecord(key:string,authorityKey:string):{operation:Pending|null;error:string}{
  try{const stored=localStorage.getItem(key);if(!stored)return{operation:null,error:''};const record=JSON.parse(stored) as Pending;
    if(record.authorityKey!==authorityKey||!record.action||!['archive','restore','selection'].includes(record.action.kind)||typeof record.action.id!=='string'||typeof record.action.input?.idempotencyKey!=='string'||!Number.isInteger(record.action.input.expectedRevision)||(record.action.kind==='selection'&&(typeof record.action.versionId!=='string'||typeof record.action.input.portfolioId!=='string'||!Number.isInteger(record.action.input.expectedPortfolioRevision)||record.action.input.selection?.mode!=='explicit'||!Array.isArray(record.action.input.selection.subjectKeys)||!Array.isArray(record.action.input.selection.passageIds))))return{operation:null,error:'Saved action recovery storage is invalid. Restore the original browser record before continuing.'};
    if(record.resolved)return{operation:null,error:''};return{operation:{...record,inFlight:false,uncertain:record.uncertain!==false||record.inFlight===true},error:''};
  }catch{return{operation:null,error:'Saved action recovery storage cannot be read. No action will be sent.'};}
}
export function DefenseSavedComparisonActions({saved,authority,onLoad,onPendingChange,disabled=false}:{saved?:DefenseSavedComparisonDto;authority:readonly[string|null,string|null,string|null];onLoad:(id:string)=>void;onPendingChange?:(pending:boolean)=>void;disabled?:boolean}){
  const api=useApi(),client=useQueryClient(),authorityKey=JSON.stringify(authority),storageKey='capiro:defense-compare-action-pending:v1:'+authorityKey;
  const mounted=useRef(true),currentAuthority=useRef(authorityKey),attempt=useRef<Pending|null>(null);currentAuthority.current=authorityKey;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const [recovery,setRecovery]=useState(()=>readRecord(storageKey,authorityKey)),[error,setError]=useState(''),[portfolioId,setPortfolioId]=useState(''),[subjectKeys,setSubjectKeys]=useState<readonly string[]>([]),[passageIds,setPassageIds]=useState<readonly string[]>([]);
  const pending=recovery.operation?.rejected?null:recovery.operation,ownLocked=!!pending||!!recovery.error,locked=ownLocked||disabled;
  useEffect(()=>{onPendingChange?.(ownLocked);},[ownLocked,onPendingChange]);
  useEffect(()=>{const action=recovery.operation?.action;if(action?.kind==='selection'){setPortfolioId(action.input.portfolioId);setSubjectKeys(action.input.selection.subjectKeys);setPassageIds(action.input.selection.passageIds);}},[recovery.operation]);
  const portfolios=useQuery({queryKey:['defense-compare-target-portfolios',...authority],queryFn:()=>listResearchPortfolios(api),enabled:!!authority[0]&&!!saved});
  const target=useQuery({queryKey:['defense-compare-target-portfolio',...authority,portfolioId],queryFn:()=>getResearchPortfolio(api,portfolioId),enabled:!!authority[0]&&!!portfolioId});
  const reload=(id:string)=>{void client.invalidateQueries({queryKey:['defense-saved-comparison',...authority,id]});void client.invalidateQueries({queryKey:['defense-saved-comparisons',...authority]});onLoad(id);};
  const execute=async(action:Action)=>action.kind==='selection'?addSavedDefenseComparisonSelection(api,action.id,action.versionId,action.input):changeSavedDefenseComparisonLifecycle(api,action.id,action.input,action.kind==='archive');
  const mutation=useMutation({mutationFn:async(kind:Action['kind'])=>{
    if(!authority[0]||recovery.error)throw Error('Authenticated recovery authority is required');
    let record:Pending;
    if(pending){record={...pending,inFlight:true};}
    else{
      if(disabled||!saved)throw Error('Load the saved capture before starting an action');
      const base={expectedRevision:saved.revision,idempotencyKey:crypto.randomUUID()};
      const action:Action=kind==='selection'?{kind,id:saved.id,versionId:saved.currentVersion.id,input:{...base,portfolioId,expectedPortfolioRevision:target.data?.revision??0,selection:{mode:'explicit',subjectKeys,passageIds}}}:{kind,id:saved.id,input:base};
      if(kind==='selection'&&(!target.data||target.data.lifecycle!=='active'||!['owner','editor'].includes(target.data.myRole)))throw Error('Choose an active editable portfolio');
      record={authorityKey,action,uncertain:false,inFlight:true};
    }
    if(record.authorityKey!==authorityKey)throw Error('The original action belongs to another authority');
    // The original IDs, selection, both revisions and key are durable BEFORE POST.
    // Recovery never recomputes them or sends automatically on mount.
    localStorage.setItem(storageKey,JSON.stringify(record));attempt.current=record;setRecovery({operation:record,error:''});return execute(record.action);
  },onSuccess:result=>{
    try{localStorage.removeItem(storageKey);}catch{try{localStorage.setItem(storageKey,JSON.stringify({...attempt.current,resolved:true,inFlight:false}));}catch{/* Confirmed server success remains known. */}}
    attempt.current=null;if(!mounted.current||currentAuthority.current!==authorityKey)return;setRecovery({operation:null,error:''});onPendingChange?.(false);setError('');reload(result.comparison.id);
  },onError:failure=>{
    const original=attempt.current;if(!original){if(mounted.current&&currentAuthority.current===authorityKey)setError('No action was sent. Check the selection and recovery storage.');return;}
    const status=(failure as {response?:{status?:number}}).response?.status,definitive=typeof status==='number'&&status>=400&&status<500&&status!==408&&status!==429,unlock=definitive&&!original.uncertain;
    const record={...original,inFlight:false,uncertain:!unlock,rejected:unlock};try{localStorage.setItem(storageKey,JSON.stringify(record));}catch{/* The earlier durable in-flight record remains conservative. */}attempt.current=null;
    if(!mounted.current||currentAuthority.current!==authorityKey)return;setRecovery({operation:record,error:''});onPendingChange?.(!unlock);setError(unlock?'The action was rejected. Your selection is retained; reload the current capture and portfolio before trying again.':'The action result is uncertain. Retry the original action before changing the selection.');
  }});
  const toggle=(values:readonly string[],id:string)=>values.includes(id)?values.filter(value=>value!==id):[...values,id];
  return<section className="dr-section" aria-label="Saved comparison actions"><h2>Saved capture actions</h2>
    {saved?<><button type="button" disabled={locked||mutation.isPending||!authority[0]} onClick={()=>mutation.mutate(saved.archivedAt?'restore':'archive')}>{saved.archivedAt?'Restore saved comparison':'Archive saved comparison'}</button>
      <p>The captured values and evidence remain available when the comparison is archived.</p>
      <fieldset disabled={locked||mutation.isPending||!!saved.archivedAt||!authority[0]}><legend>Add selected saved items to a portfolio</legend>
        <label>Target portfolio <select aria-label="Target portfolio" value={portfolioId} onChange={event=>setPortfolioId(event.target.value)}><option value="">Choose a portfolio</option>{portfolios.data?.items.filter(item=>item.lifecycle==='active'&&['owner','editor'].includes(item.myRole)).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        {saved.currentVersion.selection.subjectKeys.map(key=><label key={key}><input type="checkbox" checked={subjectKeys.includes(key)} onChange={()=>setSubjectKeys(toggle(subjectKeys,key))}/>{saved.currentVersion.capturedProjection.subjects.find(subject=>subject.key===key)?.label??key}</label>)}
        {saved.currentVersion.selection.passageIds.map(id=><label key={id}><input type="checkbox" checked={passageIds.includes(id)} onChange={()=>setPassageIds(toggle(passageIds,id))}/>{saved.currentVersion.capturedProjection.metrics.find(metric=>metric.cells.some(cell=>cell.evidence.some(e=>e.evidenceRefId==='context-compare:'+id)))?.label??'Saved passage'}</label>)}
        <p>Choose each item explicitly. Public subjects become members; context documents and passages become personal evidence bookmarks tied to this saved version.</p>
        <button type="button" disabled={!target.data||target.isFetching||target.data.lifecycle!=='active'||!['owner','editor'].includes(target.data.myRole)} onClick={()=>mutation.mutate('selection')}>Add selected saved items</button>
      </fieldset>
      {portfolios.isError||target.isError?<p role="alert">Portfolio access could not be loaded.</p>:null}</>:null}
    {error?<p role="alert">{error}</p>:null}{recovery.error?<p role="alert">{recovery.error}</p>:null}
    {pending?<><p role="status">The original saved action is retained. Recover its result before editing.</p><button type="button" disabled={mutation.isPending} onClick={()=>mutation.mutate(pending.action.kind)}>Retry original saved action</button></>:null}
    {recovery.operation?.rejected?<button type="button" onClick={()=>{reload(recovery.operation!.action.id);void target.refetch();}}>Reload current saved action inputs</button>:null}
    {mutation.isPending?<p role="status">Saving capture action…</p>:null}
  </section>;
}
