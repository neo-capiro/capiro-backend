import { useEffect, useRef, useState } from 'react';
import { CapiroButton } from '../../components/actions/index.js';
import { DashboardIcon } from '../../components/untitledui/dashboard-icons.js';
import type {
  DashboardDensity,
  DashboardVNextModel,
} from '../../adapters/legacy/useDashboardVNextModel.js';
import type { NewsPolicyTopic } from '../../../pages/dashboard/DashboardNewsAndNarrative.js';

const TOPICS: ReadonlyArray<{ value: NewsPolicyTopic; label: string }> = [
  { value: 'legislation', label: 'Legislation' },
  { value: 'hearings', label: 'Hearings & markups' },
  { value: 'regulation', label: 'Regulation' },
  { value: 'budget', label: 'Budget & appropriations' },
  { value: 'procurement', label: 'Procurement & contracts' },
  { value: 'grants', label: 'Grants & funding' },
  { value: 'state', label: 'State policy' },
  { value: 'executive', label: 'Executive actions' },
];
const DENSITIES: ReadonlyArray<{ value: DashboardDensity; label: string; sub: string }> = [
  { value: 'presentation', label: 'Presentation', sub: 'More breathing room · fewer rows' },
  { value: 'standard', label: 'Standard', sub: 'Balanced spacing and context' },
  { value: 'compact', label: 'Compact', sub: 'More rows · news summaries hidden' },
];
const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),[tabindex]:not([tabindex="-1"])';

type WorkKey = 'today' | 'work';

export function CustomizeDrawer({ model, onClose, onDensityChange, initialSection }: { model: DashboardVNextModel; onClose: () => void; onDensityChange?: (next: DashboardDensity) => void; initialSection?: 'x' | null }) {
  const panelRef = useRef<HTMLElement | null>(null);
  const xSectionRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<WorkKey | null>(null);
  const [xDraft, setXDraft] = useState('');
  const [xError, setXError] = useState<string | null>(null);
  const [addingX, setAddingX] = useState(false);
  const [editingCustom, setEditingCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState(() => model.news.preferences.customTopics.join(', '));
  const workOrder = model.order.filter((key): key is WorkKey => key === 'today' || key === 'work');
  const wireEnabled = model.visibility.news || model.visibility.xFeed;
  const prefs = model.news.preferences;

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();
    if (initialSection === 'x') window.requestAnimationFrame(() => xSectionRef.current?.scrollIntoView({ block: 'start' }));
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.tabIndex !== -1);
      if (!focusable.length) return;
      const first = focusable[0]!, last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = oldOverflow; previous?.focus(); };
  }, [initialSection, onClose]);

  const setWorkOrder = (next: WorkKey[]) => {
    const rest = model.order.filter((key) => key !== 'today' && key !== 'work');
    model.setOrder([...next, ...rest]);
  };
  const dropOn = (target: WorkKey) => {
    if (!dragging || dragging === target) return;
    const next = workOrder.filter((key) => key !== dragging);
    next.splice(workOrder.indexOf(target), 0, dragging);
    setWorkOrder(next);
    setDragging(null);
  };
  const move = (key: WorkKey, delta: number) => {
    const next = [...workOrder];
    const from = next.indexOf(key), to = from + delta;
    if (from < 0 || to < 0 || to >= next.length) return;
    [next[from], next[to]] = [next[to]!, next[from]!];
    setWorkOrder(next);
  };
  const addX = async () => {
    const username = xDraft.trim().replace(/^@+/, '');
    if (!username) return;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(username)) { setXError('Enter a valid X username (letters, numbers, underscore; 15 characters max).'); return; }
    if (model.xFeed.subscriptions.some((sub) => sub.username.toLowerCase() === username.toLowerCase())) {
      setXError(`@${username} is already in your feed.`); return;
    }
    setAddingX(true); setXError(null);
    try { await model.xFeed.addSource(username); setXDraft(''); }
    catch { setXError('Could not add this account. Check the handle and try again.'); }
    finally { setAddingX(false); }
  };
  const toggleTopic = (topic: NewsPolicyTopic) => {
    const checked = prefs.policyTopics.includes(topic);
    model.news.setPreferences({ ...prefs, policyTopics: checked ? prefs.policyTopics.filter((value) => value !== topic) : [...prefs.policyTopics, topic] });
  };
  const saveCustomTopics = () => {
    const customTopics = customDraft.split(',').map((value) => value.trim()).filter(Boolean).slice(0, 20).map((value) => value.slice(0, 120));
    model.news.setPreferences({ ...model.news.preferences, customTopics });
    setEditingCustom(false);
  };
  const reset = () => {
    model.setVisibility({ today: true, work: true, news: true, xFeed: true });
    model.setOrder(['today', 'work', 'news', 'xFeed']);
    model.setDensity('standard');
  };

  return (
    <div className="dashv2-drawer-scrim" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Customize Dashboard" className="dashv2-drawer">
        <div className="dashv2-drawer__body">
          <header className="dashv2-drawer__header">
            <span className="dashv2-feature-icon dashv2-feature-icon--lg" aria-hidden="true"><DashboardIcon name="Sliders02" size={24} /></span>
            <span className="dashv2-drawer__header-copy"><h2>Customize Dashboard</h2><p>Lanes, wire subscriptions and density. Needs Attention stays pinned to the top strip.</p></span>
            <button type="button" className="dashv2-icon-button" aria-label="Close" onClick={onClose}><DashboardIcon name="XClose" size={20} /></button>
          </header>
          <div className="dashv2-drawer__divider" />

          <SectionHead label="Pinned strip" hint="Always visible" />
          <div className="dashv2-drawer-card dashv2-drawer-card--pinned"><span><strong>Needs Attention</strong><small>Four triage tiles under the greeting</small></span><span className="dashv2-pill dashv2-pill--brand">Pinned</span></div>

          <SectionHead label="Work lane" hint="Drag to reorder" />
          {workOrder.map((key) => {
            const title = key === 'today' ? 'Today & Coming Up' : 'Work Queue';
            const sub = key === 'today' ? 'Chronological meetings and deadlines' : 'Outreach and work documents';
            const visible = key === 'today' ? model.visibility.today : model.visibility.work;
            return <div key={key} className="dashv2-drawer-card dashv2-drawer-card--module" draggable data-dragging={dragging === key || undefined} onDragStart={() => setDragging(key)} onDragEnd={() => setDragging(null)} onDragOver={(e) => e.preventDefault()} onDrop={() => dropOn(key)}>
              <button type="button" className="dashv2-drag" aria-label={`Reorder ${title}`} onKeyDown={(e) => { if (e.key === 'ArrowUp') { e.preventDefault(); move(key,-1); } if (e.key === 'ArrowDown') { e.preventDefault(); move(key,1); } }}><DashboardIcon name="DotsGrid" size={20} /></button>
              <span className="dashv2-drawer-card__copy"><strong>{title}</strong><small>{sub}</small></span>
              <Switch checked={visible} label={`Show ${title}`} onClick={() => model.setVisibility({ ...model.visibility, [key]: !visible })} />
            </div>;
          })}

          <SectionHead label="The Wire" hint="Right lane" />
          <div className="dashv2-drawer-card dashv2-drawer-card--module"><span className="dashv2-drawer-card__copy"><strong>The Wire</strong><small>Right lane · X posts and news, newest first</small></span><Switch checked={wireEnabled} label="Show The Wire" onClick={() => model.setVisibility({ ...model.visibility, news: !wireEnabled, xFeed: !wireEnabled })}/></div>

          <div className="dashv2-drawer__divider" />
          <div ref={xSectionRef} className="dashv2-drawer-anchor" />
          <SectionHead label="X accounts" hint={`${model.xFeed.subscriptions.length} subscribed`} />
          <p className="dashv2-drawer__helper">Posts are read-only and refresh with the dashboard.</p>
          {model.xFeed.subscriptions.map((sub) => <div key={sub.id} className="dashv2-account"><span className="dashv2-avatar dashv2-avatar--tiny">{initials(sub.displayName ?? sub.username)}</span><span className="dashv2-account__copy"><strong>@{sub.username}</strong>{sub.displayName ? <small>{sub.displayName}</small> : null}</span><button type="button" className="dashv2-account__remove" aria-label={`Remove @${sub.username}`} onClick={() => void model.xFeed.removeSource(sub.id)}><DashboardIcon name="XClose" size={16} /></button></div>)}
          <div className="dashv2-add-row"><input value={xDraft} onChange={(e)=>setXDraft(e.target.value)} onKeyDown={(e)=>{if(e.key==='Enter'){e.preventDefault();void addX();}}} placeholder="@username" aria-label="X username"/><CapiroButton variant="secondary" size="standard" disabled={addingX} onClick={() => void addX()}>{addingX?'Adding…':'Add'}</CapiroButton></div>
          {xError ? <p className="dashv2-drawer__error">{xError}</p> : null}

          <div className="dashv2-drawer__divider" />
          <SectionHead label="News subscriptions" hint="Topics" />
          <div className="dashv2-topic-list">{TOPICS.map((topic) => { const checked=prefs.policyTopics.includes(topic.value); return <button key={topic.value} type="button" className="dashv2-topic" role="checkbox" aria-checked={checked} onClick={()=>toggleTopic(topic.value)}><span className="dashv2-check" data-checked={checked||undefined}><DashboardIcon name="Check" size={14} /></span><span>{topic.label}</span></button>; })}</div>
          <div className="dashv2-custom-sources"><span>{prefs.customTopics.length} custom source{prefs.customTopics.length===1?'':'s'}</span><button type="button" className="dashv2-link" onClick={() => { setCustomDraft(prefs.customTopics.join(', ')); setEditingCustom((value) => !value); }}>{editingCustom ? 'Cancel' : 'Edit'}</button></div>
          {editingCustom ? <div className="dashv2-add-row dashv2-add-row--custom"><input value={customDraft} onChange={(e)=>setCustomDraft(e.target.value)} onKeyDown={(e)=>{if(e.key==='Enter'){e.preventDefault();saveCustomTopics();}}} placeholder="policy topic, committee, organization" aria-label="Custom news sources"/><CapiroButton variant="secondary" size="standard" onClick={saveCustomTopics}>Save</CapiroButton></div> : null}

          <div className="dashv2-drawer__divider" />
          <SectionHead label="Information density" hint={`Current: ${capitalize(model.density)}`} />
          {DENSITIES.map((option) => <button key={option.value} type="button" className="dashv2-density" aria-pressed={model.density===option.value} onClick={()=> (onDensityChange ?? model.setDensity)(option.value)}><span className="dashv2-radio"><i /></span><span><strong>{option.label}</strong><small>{option.sub}</small></span></button>)}
        </div>
        <footer className="dashv2-drawer__footer"><CapiroButton variant="secondary" size="standard" onClick={reset}>Reset</CapiroButton><CapiroButton variant="primary" size="standard" onClick={onClose}>Done</CapiroButton></footer>
      </section>
    </div>
  );
}

function SectionHead({ label, hint }: { label: string; hint: string }) { return <div className="dashv2-drawer__section-head"><strong>{label}</strong><span>{hint}</span></div>; }
function Switch({ checked, label, onClick }: { checked: boolean; label: string; onClick: () => void }) { return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="dashv2-switch" data-on={checked||undefined} onClick={onClick}><i /></button>; }
function initials(value: string){return value.split(/\s+/).filter(Boolean).slice(0,2).map((part)=>part[0]?.toUpperCase()).join('')||'—';}
function capitalize(value:string){return value.slice(0,1).toUpperCase()+value.slice(1);}
