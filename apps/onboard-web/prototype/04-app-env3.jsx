// ── Environment 3 — Capiro App: personal setup gate, dashboard, trial overlay ──

const OB_PERSONAS = {
  super:    { name:'Dana Whitfield', initials:'DW', role:'Super Admin',    title:'Managing Partner', email:'dana@meridian-strategies.com' },
  admin:    { name:'Omar Reyes',     initials:'OR', role:'Admin',          title:'Director of Operations', email:'omar.reyes@meridian-strategies.com' },
  standard: { name:'Priya Shah',     initials:'PS', role:'Standard User',  title:'Senior Associate', email:'priya.shah@meridian-strategies.com' },
};

function AppSidebar({ active='Dashboard', set }) {
  const nav = [
    {icon:'LayoutDashboard',label:'Dashboard'},
    {icon:'CalendarCheck',label:'Engagement'},
    {icon:'Network',label:'Portfolio'},
    {icon:'FolderOpen',label:'Workspace'},
    {icon:'BookUser',label:'Directory'},
    {icon:'Radar',label:'Intelligence'},
  ];
  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <span style={{width:22,height:22,borderRadius:'50%',border:'2px solid #cfc9bd',position:'relative',display:'inline-block',flexShrink:0}}>
          <span style={{position:'absolute',left:'50%',top:'50%',width:9,height:1.6,background:'#cfc9bd',transformOrigin:'left',transform:'rotate(-38deg)'}}></span>
        </span>
        <b style={{fontSize:15,color:'#fff',fontWeight:600,letterSpacing:'-0.01em'}}>Capiro</b>
      </div>
      {nav.map(item=>(
        <div key={item.label} data-tour={item.label} className={`sb-item${item.label===active?' active':''}`}>
          <span className="ico"><Icon name={item.icon} size={15}/></span>
          <span className="label">{item.label}</span>
        </div>
      ))}
      <div className="sb-spacer"></div>
      <div style={{height:1,background:'rgba(255,255,255,0.06)',margin:'8px 0'}}></div>
      <div className="sb-item"><span className="ico"><Icon name="Settings" size={15}/></span><span className="label">Settings</span></div>
      <div className="sb-item" style={{cursor:'pointer'}} onClick={()=>set&&set({tour:0,tourDone:false})}><span className="ico"><Icon name="CircleHelp" size={15}/></span><span className="label">Help &amp; product tour</span></div>
    </aside>
  );
}

function AppTopbar({ S, here='Dashboard' }) {
  const p = OB_PERSONAS[S.persona];
  return (
    <header className="topbar">
      <div className="tb-breadcrumb">
        <span>{S.orgName}</span><Icon name="ChevronRight" size={12} style={{opacity:0.4}}/><span className="here">{here}</span>
      </div>
      <div className="tb-search" style={{flex:1,maxWidth:380,marginLeft:12}}>
        <Icon name="Search" size={13}/><span>Search bills, agencies, stakeholders…</span><span className="kbd">⌘K</span>
      </div>
      <div className="tb-spacer"></div>
      <button className="tb-iconbtn"><Icon name="Bell" size={14}/></button>
      <button className="tb-iconbtn"><Icon name="Settings" size={14}/></button>
      <div className="tb-avatar">
        <div className="ava" style={{background:'linear-gradient(135deg,#2A57CE,#1A3F9F)'}}>{p.initials}</div>
        <div className="meta"><div className="name">{p.name}</div><div className="role">{p.title}</div></div>
      </div>
    </header>
  );
}

// Flow 3 — persistent trial banner (below top nav on every app screen)
function TrialBanner({ S, set, go }) {
  if (S.billing!=='trialing') return null;
  const isSuper = S.persona==='super';
  return (
    <div style={{background:'var(--notable-soft)',borderBottom:'1px solid rgba(162,105,19,0.25)',display:'flex',alignItems:'center',gap:10,padding:'6px 20px',flexShrink:0}}>
      <Icon name="Hourglass" size={13} style={{color:'var(--notable)'}}/>
      <span style={{fontSize:12,fontWeight:600,color:'var(--notable)'}}>
        Free trial · 18 days remaining · <span style={{fontFamily:'var(--font-mono)',letterSpacing:0}}>{S.imported||8}/10</span> profiles used
      </span>
      <span style={{flex:1}}></span>
      {isSuper ? (
        <button onClick={()=>go && go('app-billing')} style={{fontFamily:'var(--font-sans)',fontSize:11.5,fontWeight:700,color:'#fff',background:'var(--notable)',border:'none',borderRadius:5,padding:'4px 12px',cursor:'pointer'}}>Upgrade Now</button>
      ) : (
        <span style={{fontSize:11.5,color:'var(--notable)'}}>Contact your Super Admin to upgrade.</span>
      )}
    </div>
  );
}

// App shell wrapper for environment 3
function AppFrame({ S, set, go, here, children, dimmed }) {
  return (
    <div style={{height:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-canvas)'}}>
      <EnvBar url={`${S.slug||'meridian'}.capiro.ai`}/>
      <div className="app-shell" style={{flex:1,display:'grid',gridTemplateColumns:'208px 1fr',minHeight:0}}>
        <AppSidebar active={here} set={set}/>
        <div style={{display:'flex',flexDirection:'column',minWidth:0,minHeight:0}}>
          <AppTopbar S={S} here={here}/>
          <TrialBanner S={S} set={set} go={go}/>
          <div style={{flex:1,minHeight:0,overflowY:'auto',position:'relative',opacity:dimmed?0.55:1,pointerEvents:dimmed?'none':'auto'}}>
            {children}
          </div>
        </div>
      </div>
      {/* Floating Meri assistant — bottom-right on every app screen */}
      <button className="meri-fab" data-tour="Meri" title="Ask Meri" style={{position:'fixed',bottom:24,right:24,zIndex:60,width:56,height:56,borderRadius:'50%',border:'none',cursor:'pointer',
        background:'linear-gradient(135deg,#4f46e5,#2A57CE)',display:'grid',placeItems:'center',boxShadow:'0 10px 26px rgba(42,87,206,0.42)'}}>
        <svg viewBox="0 0 24 24" width="26" height="26" fill="#fff"><path d="M12 2.2l1.9 5.6 5.6 1.9-5.6 1.9L12 17.2l-1.9-5.6L4.5 9.7l5.6-1.9z"/><path d="M18.2 13.4l.85 2.45 2.45.85-2.45.85-.85 2.45-.85-2.45-2.45-.85 2.45-.85z" opacity="0.85"/></svg>
      </button>
    </div>
  );
}

// ── 2B.1–2B.3 — Personal setup gate sequence ───────────────────────────────
function PersonalSetupGate({ S, set, go }) {
  const [phase, setPhase] = React.useState(S.personalConnected?'connected':'gate'); // gate → connecting → connected → prefs
  const p = OB_PERSONAS[S.persona];
  const connect = () => { setPhase('connecting'); setTimeout(()=>{ setPhase('connected'); set({personalConnected:true}); },1500); };
  return (
    <React.Fragment>
      <AppFrame S={S} set={set} go={go} here="Dashboard" dimmed>
        <DashboardBody S={S} skeleton/>
      </AppFrame>
      <div style={{position:'fixed',inset:0,background:'rgba(12,26,56,0.5)',display:'grid',placeItems:'center',zIndex:50,padding:24}}>
        <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:440,boxShadow:'0 18px 50px rgba(12,26,56,0.35)',padding:'36px 34px',textAlign:'center'}}>
          {phase==='gate' || phase==='connecting' ? (
            <>
              <div style={{width:50,height:50,borderRadius:'50%',background:'var(--accent-soft)',display:'grid',placeItems:'center',margin:'0 auto 16px'}}>
                <Icon name="MailPlus" size={22} style={{color:'var(--accent)'}}/>
              </div>
              <h2 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:23,letterSpacing:'-0.015em'}}>One last step before you can get started</h2>
              <p style={{margin:'10px 0 4px',fontSize:13.5,fontWeight:600,color:'var(--ink-1)'}}>Connect your email and calendar</p>
              <p style={{margin:'0 0 20px',fontSize:12.5,color:'var(--ink-2)'}}>Required for all Capiro features. Takes 30 seconds.</p>
              {phase==='connecting' ? (
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontSize:13,color:'var(--ink-2)',padding:'10px 0'}}>
                  <Spinner size={16}/>Connecting {p.email}…
                </div>
              ) : (
                <div style={{display:'grid',gap:10}}>
                  <Btn variant="secondary" size="lg" onClick={connect} style={{width:'100%'}}><MsGlyph/> Connect with Microsoft</Btn>
                  <Btn variant="secondary" size="lg" onClick={connect} style={{width:'100%'}}><GGlyph/> Connect with Google</Btn>
                </div>
              )}
              <div style={{marginTop:16,fontSize:11.5,color:'var(--ink-4)'}}>This step can't be skipped — your workspace unlocks once connected.</div>
            </>
          ) : phase==='connected' ? (
            <>
              <div style={{width:50,height:50,borderRadius:'50%',background:'var(--success-soft)',display:'grid',placeItems:'center',margin:'0 auto 16px'}}>
                <Icon name="Check" size={24} strokeWidth={2.6} style={{color:'var(--success)'}}/>
              </div>
              <h2 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:24,letterSpacing:'-0.015em'}}>You're connected.</h2>
              <p style={{margin:'8px 0 20px',fontSize:13,color:'var(--ink-2)'}}>
                <b style={{color:'var(--ink-1)',fontFamily:'var(--font-mono)',letterSpacing:0,fontSize:12.5}}>{p.email}</b><br/>confirmed for email and calendar sync.
              </p>
              <Btn variant="primary" onClick={()=>go('2b-dash')} icon="ArrowRight" style={{width:'100%'}}>Continue to Capiro</Btn>
              <div style={{marginTop:14}}>
                <a href="#" onClick={e=>{e.preventDefault();setPhase('prefs');}} style={{fontSize:12.5,color:'var(--accent)',fontWeight:600}}>Set personal AI preferences first</a>
                <span style={{fontSize:12,color:'var(--ink-3)'}}> · optional</span>
              </div>
            </>
          ) : (
            <PersonalPrefs S={S} set={set} go={go}/>
          )}
        </div>
      </div>
    </React.Fragment>
  );
}

// 2B.3 — personal AI settings (skippable)
function PersonalPrefs({ S, set, go }) {
  return (
    <div style={{textAlign:'left'}}>
      <h2 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:22,letterSpacing:'-0.015em',textAlign:'center'}}>Personalize your Meri experience</h2>
      <p style={{margin:'8px 0 18px',fontSize:12.5,color:'var(--ink-2)',textAlign:'center'}}>Layered on top of {S.orgName}'s firm-wide settings.</p>
      <div style={{display:'grid',gap:13}}>
        <Field label="Preferred tone"><SelectInput options={['Match firm default','Direct and brief','Warm and consultative','Formal']} value={S.myTone||'Match firm default'} onChange={v=>set({myTone:v})}/></Field>
        <Field label="Communication style notes"><textarea rows={2} style={{...obInputStyle,resize:'vertical'}} placeholder="e.g. lead with the ask, keep briefs under 200 words"></textarea></Field>
        <Field label="Any restrictions" optional><textarea rows={2} style={{...obInputStyle,resize:'vertical'}} placeholder="Topics Meri should avoid for you"></textarea></Field>
      </div>
      <div style={{display:'flex',gap:10,marginTop:18}}>
        <Btn onClick={()=>go('2b-dash')} style={{flex:1}}>Skip for now</Btn>
        <Btn variant="primary" onClick={()=>go('2b-dash')} style={{flex:1}}>Save preferences</Btn>
      </div>
    </div>
  );
}

// ── 2B.4 — Dashboard (populated, first login, walkthrough tooltip) ─────────
const OB_ATTN = [
  { sev:'var(--critical)', eyebrow:'Comment deadline · 2 days', title:'FAA Part 108 BVLOS operations — comment period closes July 4', ctx:'Overland AI' },
  { sev:'var(--notable)',  eyebrow:'Hearing · Tomorrow 10:00 AM', title:'SASC Airland: FY27 tactical aviation modernization', ctx:'Aperture Defense' },
  { sev:'var(--notable)',  eyebrow:'Bill movement · 4h ago', title:'S.2417 reported out of committee with amendments', ctx:'Mimir Advisors' },
  { sev:'var(--accent)',   eyebrow:'Contract award · Yesterday', title:'DISA awards $84M zero-trust IDIQ — competitor on team', ctx:'Helix Federal' },
  { sev:'var(--accent)',   eyebrow:'Regulation · 1d ago', title:'OMB draft guidance on AI procurement standards circulated', ctx:'Overland AI' },
];
const OB_MEETINGS = [
  { when:'9:30am', title:'Mimir Advisors — weekly check-in', sub:'Lia Martinez · Teams', tag:['Prepped','success'] },
  { when:'11:00am', title:'Hill day prep — Rep. Strong office (AL-05)', sub:'Aperture Defense · In person', tag:['Prep needed','critical'] },
  { when:'2:30pm', title:'Overland AI — Part 108 comment strategy', sub:'Neo Martinez · Teams', tag:['Prepped','success'] },
];
const OB_DRAFTS = [
  { title:'Follow-up: SASC staff briefing request', sub:'Aperture Defense · 3 recipients', ready:true },
  { title:'Part 108 comment letter — client review', sub:'Overland AI · No recipients yet', ready:false },
  { title:'Q3 priorities memo to leadership', sub:'Mimir Advisors · 1 recipient', ready:true },
];

function PanelHead({ title }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:10,padding:'12px 18px',borderBottom:'1px solid var(--border-1)'}}>
      <b style={{fontSize:13,letterSpacing:'-0.005em'}}>{title}</b>
      <a href="#" onClick={e=>e.preventDefault()} style={{marginLeft:'auto',fontSize:11.5,color:'var(--ink-3)',textDecoration:'none'}}>Open Engagement Manager →</a>
    </div>
  );
}

function DashboardBody({ S, set, skeleton, walkthrough }) {
  const p = OB_PERSONAS[S.persona];
  const first = p.name.split(' ')[0];
  const sk = skeleton;
  const week = [['MON','29'],['TUE','30'],['WED','1'],['THU','2',true],['FRI','3'],['SAT','4'],['SUN','5']];
  return (
    <div style={{padding:'22px 26px 40px',maxWidth:1180,margin:'0 auto'}}>
      {/* Greeting row */}
      <div style={{marginBottom:16}}>
        <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:28,letterSpacing:'-0.015em'}}>Good Morning, {first}.</h1>
        <p style={{margin:'4px 0 0',fontSize:12.5,color:'var(--ink-3)'}}>Thursday, July 2, 2026 · 119th Congress · <b style={{fontFamily:'var(--font-mono)',letterSpacing:0,color:'var(--ink-2)'}}>14</b> new signals overnight · <span style={{color:'var(--critical)',fontWeight:600}}>2 critical actions today</span></p>
      </div>

      {/* Needs Attention strip */}
      <div style={{background:'#fff',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 1px 2px rgba(21,22,26,0.04)',overflow:'hidden',marginBottom:16,position:'relative'}}>
        <div style={{display:'flex',alignItems:'baseline',gap:10,padding:'12px 18px',borderBottom:'1px solid var(--border-1)'}}>
          <b style={{fontSize:13}}>Needs Attention</b>
          <span style={{marginLeft:'auto',fontSize:11.5,color:'var(--ink-3)'}}>{OB_ATTN.length} items · <span style={{textDecoration:'underline'}}>see all →</span></span>
        </div>
        <div style={{display:'flex',gap:1,background:'var(--border-1)',overflowX:'auto'}}>
          {OB_ATTN.map((a,i)=>(
            <div key={i} style={{flex:'0 0 285px',background:'#fff',padding:'12px 16px',display:'flex',flexDirection:'column',gap:4}}>
              {sk ? <div style={{height:44,background:'var(--bg-sunken)',borderRadius:4}}></div> : <>
                <span style={{fontSize:10.5,textTransform:'uppercase',letterSpacing:'0.05em',fontWeight:700,color:'var(--ink-3)',display:'inline-flex',alignItems:'center',gap:6}}>
                  <span style={{width:6,height:6,borderRadius:'50%',background:a.sev}}></span>{a.eyebrow}
                </span>
                <span style={{fontSize:13.5,fontWeight:600,lineHeight:1.35}}>{a.title}</span>
                <span style={{fontSize:11.5,color:'var(--ink-2)'}}>{a.ctx}</span>
              </>}
            </div>
          ))}
        </div>
      </div>

      {/* Meri brief */}
      <div style={{background:'#fff',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 1px 2px rgba(21,22,26,0.04)',padding:'18px 20px 14px',marginBottom:16,position:'relative',overflow:'hidden'}}>
        <span style={{position:'absolute',top:0,right:0,borderStyle:'solid',borderWidth:'0 26px 26px 0',borderColor:'transparent #f5a623 transparent transparent'}}></span>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:10}}>
          <span style={{width:38,height:38,borderRadius:'50%',background:'linear-gradient(135deg,#4f46e5,#2A57CE)',display:'grid',placeItems:'center',flexShrink:0}}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="#fff"><path d="M12 2.2l1.9 5.6 5.6 1.9-5.6 1.9L12 17.2l-1.9-5.6L4.5 9.7l5.6-1.9z"/><path d="M18.2 13.4l.85 2.45 2.45.85-2.45.85-.85 2.45-.85-2.45-2.45-.85 2.45-.85z" opacity="0.85"/></svg>
          </span>
          <div>
            <div style={{fontSize:13,fontWeight:600,color:'#4f46e5'}}>Meri briefing</div>
            <div style={{fontSize:12,color:'var(--ink-3)'}}>Thursday, July 2, 2026</div>
          </div>
        </div>
        {sk ? <div style={{height:58,background:'var(--bg-sunken)',borderRadius:4}}></div> : (
          <p style={{margin:0,fontSize:15,lineHeight:1.7,color:'var(--ink-1)',fontFamily:'var(--font-serif)',textWrap:'pretty'}}>
            <mark style={{background:'var(--critical-soft)',borderRadius:3,padding:'0 2px'}}>The FAA Part 108 comment period closes in 2 days — Overland AI's letter is still in draft.</mark>{' '}
            <mark style={{background:'var(--notable-soft)',borderRadius:3,padding:'0 2px'}}>S.2417 was reported out of committee yesterday with two amendments relevant to Mimir Advisors.</mark>{' '}
            Otherwise a quiet portfolio: 14 signals overnight, most routine. Your 11am Hill-day prep for Aperture Defense still needs a briefing packet.
          </p>
        )}
        <div style={{display:'flex',alignItems:'center',marginTop:12,paddingTop:10,borderTop:'1px solid var(--border-1)'}}>
          <span style={{fontSize:11.5,color:'var(--ink-3)'}}>Synthesized by Meri</span>
          <a href="#" onClick={e=>e.preventDefault()} style={{marginLeft:'auto',fontSize:12,color:'var(--ink-2)'}}>See all changes →</a>
        </div>
      </div>

      {/* Two-column: Client Engagement + Outreach Drafts */}
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16}}>
        <div style={{background:'#fff',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 1px 2px rgba(21,22,26,0.04)',overflow:'hidden',display:'flex',flexDirection:'column',height:360}}>
          <PanelHead title="Client Engagement"/>
          <div style={{fontSize:10,textTransform:'uppercase',letterSpacing:'0.08em',fontWeight:700,color:'var(--ink-3)',padding:'10px 18px 4px'}}>Meetings · This Week</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr)',gap:4,padding:'4px 14px 10px',borderBottom:'1px solid var(--border-1)'}}>
            {week.map(([wd,num,today])=>(
              <div key={wd} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:1,padding:'5px 0',borderRadius:7,
                background:today?'var(--accent)':'transparent',boxShadow:'none'}}>
                <span style={{fontSize:9,textTransform:'uppercase',letterSpacing:'0.06em',color:today?'rgba(255,255,255,0.82)':'var(--ink-3)'}}>{wd}</span>
                <span style={{fontSize:13,fontWeight:600,fontFamily:'var(--font-mono)',letterSpacing:0,color:today?'#fff':'var(--ink-1)'}}>{num}</span>
              </div>
            ))}
          </div>
          <div style={{flex:1,overflowY:'auto'}}>
            {OB_MEETINGS.map((m,i)=>(
              <div key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'10px 18px',borderBottom:'1px solid var(--border-1)'}}>
                {sk ? <div style={{height:30,flex:1,background:'var(--bg-sunken)',borderRadius:4}}></div> : <>
                  <span style={{fontSize:11,fontFamily:'var(--font-mono)',letterSpacing:0,color:'var(--ink-3)',width:52,flexShrink:0}}>{m.when}</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13.5,fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{m.title}</div>
                    <div style={{fontSize:11.5,color:'var(--ink-3)'}}>{m.sub}</div>
                  </div>
                  <Tag tone={m.tag[1]}>{m.tag[0]}</Tag>
                </>}
              </div>
            ))}
          </div>
        </div>
        <div style={{background:'#fff',border:'1px solid var(--border-1)',borderRadius:8,boxShadow:'0 1px 2px rgba(21,22,26,0.04)',overflow:'hidden',display:'flex',flexDirection:'column',height:360}}>
          <PanelHead title="Outreach Drafts"/>
          <div style={{flex:1,overflowY:'auto'}}>
            {OB_DRAFTS.map((d,i)=>(
              <div key={i} style={{display:'flex',alignItems:'center',gap:12,padding:'12px 18px',borderBottom:'1px solid var(--border-1)'}}>
                {sk ? <div style={{height:30,flex:1,background:'var(--bg-sunken)',borderRadius:4}}></div> : <>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13.5,fontWeight:600,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{d.title}</div>
                    <div style={{fontSize:11.5,color:'var(--ink-3)'}}>{d.sub}</div>
                  </div>
                  <Tag tone={d.ready?'success':'neutral'}>{d.ready?'Ready to send':'Draft'}</Tag>
                </>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── First-login product tour — dim overlay + nav spotlight + step rail ─────
const OB_TOUR = [
  { nav:'Dashboard',    h:'Your Dashboard, Tailored to You',  s:"A quick view of what's critical in the coming days. Data gets more in-depth the more you use the platform." },
  { nav:'Meri',         h:'Meri, Your AI Assistant',          s:'Meri pulls context from your connected inbox, calendar, and clients to serve as your "AI Chief of Staff." Ask Meri to perform research, update you on legislation, draft documents, and more.' },
  { nav:'Engagement',   h:'Your Client Relationship CRM',     s:'Prep for meetings, draft tailored email campaigns, and view auto-generated reports in the Engagement manager.' },
  { nav:'Portfolio',    h:"Your Organization's Client List",  s:"Your org's client profiles live here, along with key information and tailored insights for each one." },
  { nav:'Workspace',    h:'Draft Key Documents with Meri',    s:'Meri can help you quickly draft personalized memos, white papers, requests, and more.' },
  { nav:'Directory',    h:'Your Congressional Directory',     s:'View and search the full congressional directory of members, staffers, and key insights.' },
  { nav:'Intelligence', h:'Intel Tailored for You',           s:"Explore intelligence tools. LegiWatch surfaces critical insights and alerts you when relevant bills move or your clients' interests are mentioned in hearings. Data Explorer searches Capiro's full federal data records. Program Elements gives you key budget data." },
];

function DashboardTour({ S, set }) {
  const steps = OB_TOUR;
  const i = Math.max(0, Math.min(S.tour|0, steps.length-1));
  const step = steps[i];
  const [rect, setRect] = React.useState(null);
  const last = i === steps.length-1;
  const end = () => set({ tour:null, tourDone:true });

  React.useEffect(() => {
    document.body.classList.add('ob-tour');
    return () => { document.body.classList.remove('ob-tour'); const h=document.querySelector('.ob-tour-hot'); if(h) h.classList.remove('ob-tour-hot'); };
  }, []);

  React.useLayoutEffect(() => {
    const prev = document.querySelector('.ob-tour-hot'); if (prev) prev.classList.remove('ob-tour-hot');
    const el = document.querySelector(`[data-tour="${step.nav}"]`);
    const measure = () => { if (el) setRect(el.getBoundingClientRect()); };
    if (el) { el.classList.add('ob-tour-hot'); measure(); }
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('resize', measure); if (el) el.classList.remove('ob-tour-hot'); };
  }, [i]);

  const vh = (typeof window!=='undefined' && window.innerHeight) || 800;
  const vw = (typeof window!=='undefined' && window.innerWidth) || 1200;
  const W = 330;
  let place;
  if (!rect) {
    place = { style:{ top:130, left:228 }, arrow:{ left:-7, top:42 } };
  } else if (rect.top > vh*0.55) {
    // bottom-anchored target (floating Meri button) → callout above, arrow points down
    const left = Math.max(16, Math.min(rect.right - W, vw - W - 16));
    const cx = rect.left + rect.width/2;
    place = { style:{ bottom: vh - rect.top + 18, left }, arrow:{ bottom:-7, left: Math.min(Math.max(cx - left - 7, 18), W - 26) } };
  } else {
    // side target (nav item) → callout to the right, arrow points left
    const center = rect.top + rect.height/2;
    const top = Math.min(Math.max(center - 78, 46), vh - 232);
    place = { style:{ top, left: rect.right + 20 }, arrow:{ left:-7, top: Math.min(Math.max(center - top, 16), 150) } };
  }

  return (
    <React.Fragment>
      <style>{`
        body.ob-tour .sidebar{position:relative;z-index:1300;}
        body.ob-tour .sb-item{opacity:0.34;transition:opacity .2s ease, background .2s ease, box-shadow .2s ease;}
        body.ob-tour .sb-item.ob-tour-hot{opacity:1;background:rgba(42,87,206,0.30);border-radius:7px;box-shadow:0 0 0 1.5px var(--accent), 0 0 26px rgba(42,87,206,0.6);}
        body.ob-tour .sb-item.ob-tour-hot .ico{opacity:1;}
        body.ob-tour .sb-item.ob-tour-hot::before{display:none;}
        body.ob-tour .meri-fab.ob-tour-hot{z-index:1305 !important;box-shadow:0 0 0 3px #fff, 0 0 0 6px var(--accent), 0 0 34px rgba(42,87,206,0.75) !important;}
      `}</style>
      <div style={{position:'fixed',inset:0,background:'rgba(15,17,25,0.6)',zIndex:1200}}></div>
      <div style={{position:'fixed',width:W,zIndex:1310,background:'#fff',borderRadius:12,boxShadow:'0 22px 56px rgba(12,18,40,0.42)',padding:'17px 20px 15px',...place.style}}>
        <div style={{position:'absolute',width:14,height:14,background:'#fff',transform:'rotate(45deg)',borderRadius:2,...place.arrow}}></div>
        <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:13}}>
          <div style={{display:'flex',gap:4,flex:1}}>
            {steps.map((_,k)=>(<span key={k} style={{flex:1,height:3,borderRadius:2,background:k<=i?'var(--accent)':'var(--border-1)'}}></span>))}
          </div>
          <span style={{fontSize:11,fontFamily:'var(--font-mono)',letterSpacing:0,color:'var(--ink-3)',flexShrink:0}}>{i+1}/{steps.length}</span>
        </div>
        <h3 style={{margin:'0 0 6px',fontFamily:'var(--font-serif)',fontWeight:500,fontSize:18,letterSpacing:'-0.01em',lineHeight:1.22}}>{step.h}</h3>
        <p style={{margin:0,fontSize:12.5,lineHeight:1.55,color:'var(--ink-2)',textWrap:'pretty'}}>{step.s}</p>
        <div style={{display:'flex',alignItems:'center',gap:10,marginTop:16}}>
          <button onClick={end} style={{fontFamily:'var(--font-sans)',fontSize:12,color:'var(--ink-3)',background:'transparent',border:'none',cursor:'pointer',padding:0}}>Skip tour</button>
          <span style={{flex:1}}></span>
          {i>0 && <Btn size="sm" variant="secondary" onClick={()=>set({tour:i-1})}>Back</Btn>}
          <Btn size="sm" variant="primary" onClick={()=> last ? end() : set({tour:i+1})}>{last?'Finish':'Next'}</Btn>
        </div>
      </div>
    </React.Fragment>
  );
}

function AppDashboard({ S, set, go }) {
  React.useEffect(()=>{ if(!S.tourDone && (S.tour===null||S.tour===undefined)) set({tour:0}); },[]);
  const tourOn = S.tour!==null && S.tour!==undefined;
  return (
    <React.Fragment>
      <AppFrame S={S} set={set} go={go} here="Dashboard">
        <DashboardBody S={S} set={set}/>
      </AppFrame>
      {tourOn && <DashboardTour S={S} set={set}/>}
    </React.Fragment>
  );
}

// ── Feature-gating example — Portfolio page with a locked feature ──────────
const OB_CLIENTS = [
  ['Aperture Defense Systems','Defense & aerospace','Active',12],['Overland AI','Autonomy / UAS','Active',9],
  ['Mimir Advisors','Financial services','Active',7],['Helix Federal','IT modernization','Active',5],
  ['Cardinal Health Policy Group','Healthcare','Active',4],['Bluewater Energy Coalition','Energy','Active',3],
  ['Foundry Manufacturing Assn.','Trade association','Active',2],['Sable Micro','Semiconductors','Active',2],
];

function AppFeatureScreen({ S, set, go }) {
  const isSuper = S.persona==='super';
  return (
    <AppFrame S={S} set={set} go={go} here="Portfolio">
      <div style={{padding:'22px 26px 40px',maxWidth:1180,margin:'0 auto'}}>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
          <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:28,letterSpacing:'-0.015em'}}>Portfolio</h1>
          <span style={{fontSize:12,color:'var(--ink-3)',fontFamily:'var(--font-mono)',letterSpacing:0}}>{S.imported||8}/10 profiles</span>
          <span style={{flex:1}}></span>
          <Btn size="sm" icon="Plus">Add client</Btn>
        </div>

        {/* Locked feature — inline gate banner */}
        <div style={{display:'flex',alignItems:'center',gap:10,background:'var(--bg-surface-2)',border:'1px dashed var(--border-strong)',borderRadius:8,padding:'12px 16px',marginBottom:14}}>
          <Icon name="Lock" size={15} style={{color:'var(--ink-3)'}}/>
          <div style={{flex:1,fontSize:12.5,color:'var(--ink-2)'}}>
            <b style={{color:'var(--ink-1)'}}>Portfolio-wide intelligence export</b> — this feature is available on the full plan.
          </div>
          {isSuper
            ? <Btn variant="primary" size="sm" onClick={()=>go('app-billing')}>Upgrade Now →</Btn>
            : <span style={{fontSize:12,color:'var(--ink-3)'}}>Ask a Super Admin to upgrade.</span>}
        </div>

        <Card pad={0} style={{overflow:'hidden'}}>
          <div style={{display:'grid',gridTemplateColumns:'2fr 1.4fr 90px 110px',gap:0,padding:'9px 18px',borderBottom:'1px solid var(--border-1)',background:'var(--bg-surface-2)',fontSize:10.5,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:700,color:'var(--ink-3)'}}>
            <span>Client</span><span>Sector</span><span>Status</span><span style={{textAlign:'right'}}>Open signals</span>
          </div>
          {OB_CLIENTS.map(([name,sector,status,n],i)=>(
            <div key={i} style={{display:'grid',gridTemplateColumns:'2fr 1.4fr 90px 110px',alignItems:'center',padding:'10px 18px',borderBottom:i<OB_CLIENTS.length-1?'1px solid var(--border-1)':'none',fontSize:13}}>
              <b style={{fontSize:13.5,letterSpacing:'-0.005em'}}>{name}</b>
              <span style={{color:'var(--ink-2)',fontSize:12.5}}>{sector}</span>
              <span><Tag tone="success">{status}</Tag></span>
              <span style={{textAlign:'right',fontFamily:'var(--font-mono)',letterSpacing:0,fontSize:12.5,color:'var(--ink-2)'}}>{n}</span>
            </div>
          ))}
        </Card>
      </div>
    </AppFrame>
  );
}

// ── Flow 3 — Settings › Billing › Manage Plan (only Super Admins can upgrade) ─
function BillingPage({ S, set, go }) {
  const isSuper = S.persona==='super';
  const [n, setN] = React.useState(Math.max(10,S.profiles||10));
  const [justUpgraded, setJustUpgraded] = React.useState(false);
  const price = (Math.max(10,n)*200).toLocaleString();
  return (
    <AppFrame S={S} set={set} go={go} here="Settings">
      <div style={{padding:'22px 26px 40px',maxWidth:760,margin:'0 auto'}}>
        <div style={{display:'flex',alignItems:'center',gap:6,fontSize:12,color:'var(--ink-3)',marginBottom:8}}>
          <span>Settings</span><Icon name="ChevronRight" size={11} style={{opacity:0.5}}/>
          <span>Billing</span><Icon name="ChevronRight" size={11} style={{opacity:0.5}}/>
          <b style={{color:'var(--ink-1)'}}>Manage Plan</b>
        </div>
        <h1 style={{margin:'0 0 18px',fontFamily:'var(--font-serif)',fontWeight:500,fontSize:28,letterSpacing:'-0.015em'}}>Manage plan</h1>

        {!isSuper ? (
          <Card style={{textAlign:'center',padding:'44px 36px'}}>
            <div style={{width:46,height:46,borderRadius:'50%',background:'var(--bg-sunken)',display:'grid',placeItems:'center',margin:'0 auto 14px'}}>
              <Icon name="Lock" size={20} style={{color:'var(--ink-3)'}}/>
            </div>
            <b style={{fontSize:15}}>Billing is managed by your Super Admin</b>
            <p style={{margin:'8px auto 0',fontSize:13,color:'var(--ink-2)',maxWidth:380,lineHeight:1.6}}>
              Contact your organization's Super Admin to upgrade. Plan details, invoices, and payment information are only visible to Super Admins.
            </p>
          </Card>
        ) : (
          <div style={{display:'grid',gap:14}}>
            <Card pad={0} style={{overflow:'hidden'}}>
              <div style={{padding:'12px 20px',borderBottom:'1px solid var(--border-1)',display:'flex',alignItems:'center',gap:10}}>
                <b style={{fontSize:13}}>Current plan</b>
                {S.billing==='trialing' ? <Tag tone="notable">Free trial</Tag> : <Tag tone="success">Active</Tag>}
              </div>
              <div style={{padding:'14px 20px',display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:16}}>
                {(S.billing==='trialing' ? [
                  ['Trial ends','July 20, 2026 · 18 days left'],
                  ['Client profiles',`${S.imported||0} of 10 used`],
                  ['Auto-converts','Aug 1 · $2,000/mo · card •4242'],
                ] : [
                  ['Plan',`${Math.max(10,S.profiles)} client profiles`],
                  ['Monthly total',`$${(Math.max(10,S.profiles)*200).toLocaleString()}/month`],
                  ['Payment','Card ending 4242'],
                ]).map(([k,v])=>(
                  <div key={k}>
                    <div style={{fontSize:10.5,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:700,color:'var(--ink-3)',marginBottom:3}}>{k}</div>
                    <div style={{fontSize:13,fontWeight:600}}>{v}</div>
                  </div>
                ))}
              </div>
            </Card>

            {justUpgraded && (
              <div style={{display:'flex',gap:9,alignItems:'center',background:'var(--success-soft)',borderRadius:6,padding:'11px 14px',fontSize:12.5,fontWeight:600,color:'var(--success)'}}>
                <Icon name="CircleCheck" size={15}/>You're on the full plan — receipt sent to {S.email}. The trial banner is gone and all features are unlocked.
              </div>
            )}

            {S.billing==='trialing' && (
              <Card>
                <b style={{fontSize:13.5}}>Upgrade to the full plan</b>
                <p style={{margin:'6px 0 14px',fontSize:12.5,color:'var(--ink-2)',lineHeight:1.5}}>Choose your client profile tier. Your card on file is charged today and the trial ends immediately.</p>
                <div style={{display:'flex',gap:16,alignItems:'flex-end',flexWrap:'wrap'}}>
                  <Field label="Client profiles" hint="Minimum 10 · $200 per profile / month">
                    <TextInput type="number" min={10} value={n} onChange={e=>setN(parseInt(e.target.value)||10)} style={{fontFamily:'var(--font-mono)',letterSpacing:0,width:110}}/>
                  </Field>
                  <div style={{background:'var(--bg-sunken)',border:'1px solid var(--border-1)',borderRadius:6,padding:'9px 14px',fontFamily:'var(--font-mono)',fontSize:12.5,letterSpacing:0,marginBottom:20}}>
                    {Math.max(10,n)} × $200 = <b>${price}/mo</b>
                  </div>
                  <Btn variant="primary" style={{marginBottom:20}} onClick={()=>{set({billing:'active',profiles:Math.max(10,n)});setJustUpgraded(true);}}>
                    Upgrade — ${price}/month
                  </Btn>
                </div>
                <div style={{fontSize:11.5,color:'var(--ink-3)',display:'flex',gap:6,alignItems:'center'}}>
                  <Icon name="CreditCard" size={12}/>Charging card on file ending 4242 · <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>use a different method</a> · Volume discounts — contact sales
                </div>
              </Card>
            )}
          </div>
        )}
      </div>
    </AppFrame>
  );
}

Object.assign(window, { OB_PERSONAS, AppSidebar, AppTopbar, TrialBanner, AppFrame, PersonalSetupGate, PersonalPrefs, DashboardBody, AppDashboard, AppFeatureScreen, BillingPage });
