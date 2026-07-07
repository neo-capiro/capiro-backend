// ── Flow 2A — External Setup Dashboard (Environment 2) + IT Admin path ─────

// Environment-2 page shell: minimal chrome, wordmark + org name, support link.
function ExtShell({ S, children }) {
  return (
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-canvas)'}}>
      <EnvBar url="onboarding.capiro.ai"/>
      <div style={{display:'flex',alignItems:'center',gap:12,padding:'14px 40px',borderBottom:'1px solid var(--border-1)',background:'#fff'}}>
        <Wordmark/>
        <span style={{width:1,height:16,background:'var(--border-2)'}}></span>
        <span style={{fontSize:13,fontWeight:600,color:'var(--ink-2)'}}>{S.orgName} Setup</span>
        <span style={{flex:1}}></span>
        <a href="mailto:support@capiro.ai" style={{fontSize:12,color:'var(--ink-3)',textDecoration:'none',display:'inline-flex',alignItems:'center',gap:6}}>
          <Icon name="LifeBuoy" size={13}/>Need help? <span style={{color:'var(--accent)'}}>support@capiro.ai</span>
        </a>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',padding:'36px 40px 64px'}}>
        <div style={{width:'100%',maxWidth:720}}>{children}</div>
      </div>
    </div>
  );
}

function TaskStatus({ s }) {
  if (s==='done') return <Tag tone="success"><Icon name="Check" size={10} strokeWidth={3}/>Complete</Tag>;
  if (s==='progress') return <Tag tone="blue">In progress</Tag>;
  if (s==='verifying') return <Tag tone="blue"><Spinner size={9} color="var(--accent-ink)"/>Verifying</Tag>;
  if (s==='waiting') return <Tag tone="notable">Waiting on IT Admin</Tag>;
  if (s==='locked') return <Tag tone="neutral"><Icon name="Lock" size={10}/>Locked</Tag>;
  return <Tag tone="neutral">Not started</Tag>;
}

function TaskCard({ num, title, desc, status, locked, action, children }) {
  return (
    <Card pad={0} style={{opacity:locked?0.55:1,overflow:'hidden'}}>
      <div style={{display:'flex',alignItems:'flex-start',gap:14,padding:'16px 20px'}}>
        <span style={{width:26,height:26,borderRadius:'50%',flexShrink:0,display:'grid',placeItems:'center',fontSize:12,fontWeight:700,fontFamily:'var(--font-mono)',
          background:status==='done'?'var(--success-soft)':'var(--bg-sunken)',
          color:status==='done'?'var(--success)':'var(--ink-2)',border:'1px solid var(--border-1)'}}>
          {status==='done'?<Icon name="Check" size={13} strokeWidth={3}/>:locked?<Icon name="Lock" size={12}/>:num}
        </span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
            <b style={{fontSize:14,letterSpacing:'-0.005em'}}>{title}</b>
            <TaskStatus s={status}/>
          </div>
          <div style={{fontSize:12.5,color:'var(--ink-2)',marginTop:3,lineHeight:1.5,textWrap:'pretty'}}>{desc}</div>
        </div>
        {action && <div style={{flexShrink:0}}>{action}</div>}
      </div>
      {children && <div style={{borderTop:'1px solid var(--border-1)',padding:'14px 20px',background:'var(--bg-surface-2)'}}>{children}</div>}
    </Card>
  );
}

// 2A — Dashboard Home (all inline task states) — for Admin / Super Admin
function Ext2ADashboard({ S, set, go }) {
  const [newIt, setNewIt] = React.useState('');
  const emailDone = S.taskEmail==='done';
  const importDone = S.taskImport==='done';
  const aiDone = S.taskAI==='done';
  const doneCount = [emailDone,importDone,aiDone,S.taskInvites==='done'].filter(Boolean).length;
  const invitesUnlocked = emailDone && importDone && aiDone;

  // Simulated IT health check: when the IT admin connected (S.itConnected)
  // and the task isn't done yet, run spinner → success. Keyed only on
  // itConnected so the 'verifying' transition doesn't cancel its own timer;
  // a persisted 'verifying' state on mount also completes.
  React.useEffect(()=>{
    if (!S.itConnected || emailDone) return;
    set({taskEmail:'verifying'});
    const t = setTimeout(()=>set({taskEmail:'done'}), 1600);
    return ()=>clearTimeout(t);
  },[S.itConnected]);

  const cap = S.plan==='paid' ? Math.max(10,S.profiles) : 10;
  const atCap = S.imported >= cap;

  return (
    <ExtShell S={S}>
      <div style={{marginBottom:8,display:'flex',alignItems:'flex-end',justifyContent:'space-between',gap:16,flexWrap:'wrap'}}>
        <div>
          <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:28,letterSpacing:'-0.015em'}}>Welcome, {S.firstName}.</h1>
          <p style={{margin:'6px 0 0',fontSize:13.5,color:'var(--ink-2)'}}>Complete the steps below to launch your Capiro workspace.</p>
        </div>
        <div style={{textAlign:'right'}}>
          <div style={{fontSize:12,fontWeight:700,color:'var(--ink-2)',fontFamily:'var(--font-mono)',letterSpacing:0}}>{doneCount} of 4 steps complete</div>
          <div style={{width:170,height:5,background:'var(--bg-sunken)',border:'1px solid var(--border-1)',borderRadius:99,marginTop:6,overflow:'hidden'}}>
            <div style={{width:`${doneCount/4*100}%`,height:'100%',background:'var(--accent)',borderRadius:99,transition:'width 0.4s ease'}}></div>
          </div>
        </div>
      </div>

      <div style={{display:'grid',gap:12,marginTop:20}}>
        {/* Task 1 — Connect email provider */}
        <TaskCard num="1" title="Connect email provider" status={S.taskEmail}
          desc="Your IT administrator must authenticate to grant org-wide access."
          action={S.taskEmail==='done'?null:S.taskEmail==='waiting'?<Btn size="sm" onClick={()=>set({taskEmail:'waiting'})} icon="RefreshCw">Resend</Btn>:null}>
          {S.taskEmail==='done' ? (
            <div style={{display:'flex',gap:8,alignItems:'center',fontSize:12.5,color:'var(--success)',fontWeight:600}}>
              <Icon name="CircleCheck" size={15}/>Email access granted — all users can now connect individually.
            </div>
          ) : S.taskEmail==='verifying' ? (
            <div style={{display:'flex',gap:9,alignItems:'center',fontSize:12.5,color:'var(--ink-2)'}}>
              <Spinner/>Verifying connection…
            </div>
          ) : S.taskEmail==='waiting' ? (
            <div style={{fontSize:12.5,color:'var(--ink-2)',display:'flex',flexDirection:'column',gap:6}}>
              <span>Invite sent to <b>{S.itEmail}</b> · <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>Resend</a> · <a href="#" onClick={e=>{e.preventDefault();set({taskEmail:'none'});}} style={{color:'var(--accent)'}}>Add another contact</a></span>
              <span style={{fontSize:11.5,color:'var(--ink-3)'}}>IT Admin will receive an email with instructions. <a href="#" onClick={e=>{e.preventDefault();go('it-admin');}} style={{color:'var(--accent)'}}>(demo: open the IT Admin's view →)</a></span>
            </div>
          ) : (
            <div style={{display:'flex',flexDirection:'column',gap:8}}>
              <div style={{display:'flex',gap:10}}>
                <TextInput placeholder="it-admin@yourfirm.com" value={newIt} onChange={e=>setNewIt(e.target.value)} style={{maxWidth:300}}/>
                <Btn variant="primary" size="sm" disabled={!newIt.includes('@')} onClick={()=>{set({itEmail:newIt,taskEmail:'waiting'});setNewIt('');}} style={{alignSelf:'center'}}>Send Invite</Btn>
              </div>
              <span style={{fontSize:11.5,color:'var(--ink-3)'}}>IT Admin will receive an email with instructions. You can add multiple contacts.</span>
            </div>
          )}
        </TaskCard>

        {/* Task 2 — Import client profiles */}
        <TaskCard num="2" title="Import client profiles" status={S.taskImport}
          desc={`Add your client portfolio. Limit: ${cap} profiles (${S.plan==='paid'?'paid':'trial'}).`}
          action={<Btn variant={S.taskImport==='none'?'primary':'secondary'} size="sm" onClick={()=>set({overlay:'import'})}>{S.taskImport==='none'?'Start Import':S.taskImport==='done'?'Import more':'Continue Import'}</Btn>}>
          {S.taskImport!=='none' && (
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <div style={{flex:1,height:5,background:'var(--bg-sunken)',border:'1px solid var(--border-1)',borderRadius:99,overflow:'hidden'}}>
                <div style={{width:`${Math.min(100,S.imported/cap*100)}%`,height:'100%',background:atCap?'var(--notable)':'var(--accent)',borderRadius:99,transition:'width 0.3s ease'}}></div>
              </div>
              <span style={{fontSize:12,fontFamily:'var(--font-mono)',letterSpacing:0,color:'var(--ink-2)'}}>{S.imported} of {cap} profiles imported</span>
            </div>
          )}
        </TaskCard>

        {/* Task 3 — Firm AI settings */}
        <TaskCard num="3" title="Configure firm AI settings" status={S.taskAI}
          desc="Set guardrails, tone, and preferences for your whole team."
          action={S.taskAI==='done'
            ?<Btn size="sm" onClick={()=>set({overlay:'ai'})}>Edit</Btn>
            :<Btn variant="primary" size="sm" onClick={()=>set({overlay:'ai'})}>Configure</Btn>}/>

        {/* Task 4 — Invite team (gated) */}
        <TaskCard num="4" title="Invite your team" locked={!invitesUnlocked}
          status={S.taskInvites==='done'?'done':invitesUnlocked?'none':'locked'}
          desc={invitesUnlocked
            ? 'Your workspace is ready for the rest of the firm.'
            : 'Available once all above steps are complete.'}
          action={invitesUnlocked && S.taskInvites!=='done'
            ? <Btn variant="primary" size="sm" onClick={()=>set({overlay:'invites'})}>Send Invites</Btn>
            : S.taskInvites==='done' ? <Btn variant="primary" size="sm" onClick={()=>go('2b-gate')} icon="ArrowRight">Continue to Capiro</Btn> : null}/>
      </div>

      {S.overlay==='import' && <ImportOverlay S={S} set={set} go={go} cap={cap}/>}
      {S.overlay==='ai' && <AiSettingsOverlay S={S} set={set} firm/>}
      {S.overlay==='invites' && <InvitesOverlay S={S} set={set} go={go}/>}
    </ExtShell>
  );
}

// Shared modal scaffold
function Modal({ title, onClose, children, width=520 }) {
  return (
    <div style={{position:'fixed',inset:0,background:'rgba(12,26,56,0.42)',display:'grid',placeItems:'center',zIndex:60,padding:24}}>
      <div style={{background:'#fff',borderRadius:10,width:'100%',maxWidth:width,boxShadow:'0 18px 50px rgba(12,26,56,0.28)',overflow:'hidden'}}>
        <div style={{display:'flex',alignItems:'center',padding:'14px 20px',borderBottom:'1px solid var(--border-1)'}}>
          <b style={{fontSize:14.5,letterSpacing:'-0.005em'}}>{title}</b>
          <button onClick={onClose} style={{marginLeft:'auto',border:'none',background:'transparent',cursor:'pointer',color:'var(--ink-3)',display:'grid',placeItems:'center',padding:4}}>
            <Icon name="X" size={16}/>
          </button>
        </div>
        <div style={{padding:20}}>{children}</div>
      </div>
    </div>
  );
}

// 2A — Import profiles: LDA-filings flow (matches the live product).
// Stage 1: find your firm in LDA filings. Stage 2: pick filed clients to import.
const OB_LDA_FIRM = 'MERIDIAN STRATEGIES LLC';
const OB_LDA_CLIENTS = [
  ['APERTURE DEFENSE SYSTEMS','$180K',6,'2026'], ['OVERLAND AI','$140K',5,'2026'],
  ['MIMIR ADVISORS','$120K',4,'2026'], ['HELIX FEDERAL','$100K',4,'2026'],
  ['CARDINAL HEALTH POLICY GROUP','$90K',3,'2026'], ['BLUEWATER ENERGY COALITION','$80K',3,'2026'],
  ['FOUNDRY MANUFACTURING ASSN.','$60K',2,'2026'], ['SABLE MICRO','$50K',2,'2026'],
  ['NORTHPINE TIMBER ALLIANCE','$40K',2,'2025'], ['VELA ORBITAL','$30K',1,'2026'],
  ['QUARTZ CIVIC LABS','$20K',1,'2025'], ['TIDEWATER PORTS COUNCIL','$10K',1,'2025'],
  ['LANTERN BIOSCIENCE','$0',1,'2025'], ['OSPREY MARITIME GROUP','$0',1,'2024'],
];

function ImportOverlay({ S, set, go, cap }) {
  const [stage, setStage] = React.useState(S.firmFound ? 'table' : 'search');
  const [q, setQ] = React.useState('');
  const [searched, setSearched] = React.useState(false);
  const [sel, setSel] = React.useState([]);
  const imported = S.importedIds || [];
  const remaining = Math.max(0, cap - imported.length);
  const capHit = sel.length >= remaining;
  const isSuper = S.persona==='super';
  const notImported = OB_LDA_CLIENTS.filter(c=>!imported.includes(c[0]));
  const toggle = (name) => setSel(s => s.includes(name) ? s.filter(x=>x!==name) : (s.length<remaining ? [...s,name] : s));
  const doImport = () => {
    const ids = [...imported, ...sel];
    set({ importedIds: ids, imported: ids.length, taskImport: ids.length>0?'done':'none', firmFound:true, overlay:null });
  };

  if (stage==='search') return (
    <Modal title="Find your firm in LDA filings" onClose={()=>set({overlay:null})} width={620}>
      <p style={{margin:'-2px 0 14px',fontSize:13,color:'var(--ink-2)',lineHeight:1.6,textWrap:'pretty'}}>
        Your firm files lobbying disclosures (LDA) under a registrant. Find it below to pull in your actual filed clients — each lands with its federal data pre-linked, no name-guessing.
      </p>
      <div style={{display:'flex',gap:0}}>
        <TextInput placeholder="Search your firm's name (e.g. Meridian Strategies)" value={q}
          onChange={e=>{setQ(e.target.value);setSearched(false);}}
          onKeyDown={e=>{if(e.key==='Enter'&&q.trim())setSearched(true);}}
          style={{borderTopRightRadius:0,borderBottomRightRadius:0,background:'#fff'}}/>
        <button onClick={()=>q.trim()&&setSearched(true)} style={{width:46,border:'none',borderRadius:'0 6px 6px 0',background:'var(--bg-dark)',color:'#fff',cursor:'pointer',display:'grid',placeItems:'center'}}>
          <Icon name="Search" size={15}/>
        </button>
      </div>
      {searched && (
        <div onClick={()=>{setStage('table');set({firmFound:true});}}
          style={{marginTop:12,display:'flex',alignItems:'center',gap:12,border:'1px solid var(--border-1)',borderRadius:8,padding:'12px 14px',cursor:'pointer',background:'var(--bg-surface-2)'}}>
          <Icon name="Landmark" size={16} style={{color:'var(--ink-3)'}}/>
          <div style={{flex:1}}>
            <b style={{fontSize:13}}>{OB_LDA_FIRM}</b>
            <div style={{fontSize:11.5,color:'var(--ink-3)'}}>Washington, DC · Registrant since 2014 · {OB_LDA_CLIENTS.length} filed clients</div>
          </div>
          <Icon name="ChevronRight" size={15} style={{color:'var(--ink-3)'}}/>
        </div>
      )}
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:16}}>
        <Btn onClick={()=>set({overlay:null})}>Cancel</Btn>
      </div>
    </Modal>
  );

  return (
    <Modal title="Import your clients" onClose={()=>set({overlay:null})} width={720}>
      <div style={{display:'flex',alignItems:'center',gap:8,margin:'-4px 0 12px'}}>
        <Icon name="Landmark" size={14} style={{color:'var(--ink-3)'}}/>
        <b style={{fontSize:12.5}}>{OB_LDA_FIRM}</b>
        <span style={{fontSize:12.5,color:'var(--ink-3)'}}>· {OB_LDA_CLIENTS.length} filed clients</span>
        <a href="#" onClick={e=>{e.preventDefault();setStage('search');setSel([]);}} style={{marginLeft:'auto',fontSize:12.5,fontWeight:600,color:'var(--accent)'}}>Change firm</a>
      </div>
      <div style={{border:'1px solid var(--border-1)',borderRadius:8,overflow:'hidden'}}>
        <div style={{display:'grid',gridTemplateColumns:'34px 1fr 130px 70px 70px',alignItems:'center',padding:'8px 14px',background:'var(--bg-surface-2)',borderBottom:'1px solid var(--border-1)',fontSize:10.5,textTransform:'uppercase',letterSpacing:'0.06em',fontWeight:700,color:'var(--ink-3)'}}>
          <span></span><span>Client</span>
          <span style={{display:'inline-flex',alignItems:'center',gap:4}}>Lobbying spend <Icon name="ChevronsUpDown" size={11}/></span>
          <span>Filings</span><span>Latest</span>
        </div>
        <div style={{maxHeight:320,overflowY:'auto'}}>
          {OB_LDA_CLIENTS.map(([name,spend,filings,latest],i)=>{
            const isImported = imported.includes(name);
            const isSel = sel.includes(name);
            const disabled = isImported || (!isSel && capHit);
            return (
              <div key={name} onClick={()=>!disabled&&toggle(name)}
                style={{display:'grid',gridTemplateColumns:'34px 1fr 130px 70px 70px',alignItems:'center',padding:'9px 14px',
                  borderBottom:i<OB_LDA_CLIENTS.length-1?'1px solid var(--border-1)':'none',
                  cursor:disabled?'default':'pointer',opacity:(!isImported&&disabled)?0.45:1,
                  background:isSel?'var(--accent-soft)':'#fff'}}>
                <span style={{width:15,height:15,borderRadius:4,display:'grid',placeItems:'center',
                  border:isSel?'1px solid var(--accent)':'1px solid var(--border-strong)',
                  background:isSel?'var(--accent)':isImported?'var(--bg-sunken)':'#fff'}}>
                  {isSel && <Icon name="Check" size={10} strokeWidth={3} style={{color:'#fff'}}/>}
                </span>
                <span style={{display:'flex',alignItems:'center',gap:8,minWidth:0}}>
                  <b style={{fontSize:12.5,letterSpacing:'0.01em',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>{name}</b>
                  {isImported && <Tag tone="neutral">Imported</Tag>}
                </span>
                <span style={{fontFamily:'var(--font-mono)',fontSize:12,letterSpacing:0,color:'var(--ink-2)'}}>{spend}</span>
                <span style={{fontFamily:'var(--font-mono)',fontSize:12,letterSpacing:0,color:'var(--ink-2)'}}>{filings}</span>
                <span style={{fontFamily:'var(--font-mono)',fontSize:12,letterSpacing:0,color:'var(--ink-2)'}}>{latest}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:12,marginTop:12}}>
        <a href="#" onClick={e=>{e.preventDefault();setSel(notImported.slice(0,remaining).map(c=>c[0]));}}
          style={{fontSize:12.5,fontWeight:600,color:'var(--accent)'}}>Select all {notImported.length} not-yet-imported</a>
        <span style={{fontSize:12,color:'var(--ink-3)',fontFamily:'var(--font-mono)',letterSpacing:0}}>{imported.length+sel.length} / {cap} profiles</span>
      </div>
      {capHit && notImported.length>sel.length && S.plan!=='paid' && (
        <div style={{marginTop:12,display:'flex',gap:10,alignItems:'center',background:'var(--accent-soft)',borderRadius:6,padding:'11px 14px'}}>
          <Icon name="Sparkles" size={15} style={{color:'var(--accent-ink)',flexShrink:0}}/>
          <span style={{flex:1,fontSize:12.5,color:'var(--accent-ink)',lineHeight:1.5}}>
            That's your 10-profile trial limit — {notImported.length-sel.length} filed clients still waiting. {isSuper?'Subscribe to bring in your full portfolio.':'Ask a Super Admin to subscribe for the full portfolio.'}
          </span>
          {isSuper && <Btn variant="primary" size="sm" onClick={()=>{doImport();go('app-billing');}}>View subscription options</Btn>}
        </div>
      )}
      {capHit && S.plan==='paid' && notImported.length>sel.length && (
        <div style={{marginTop:12,fontSize:12,color:'var(--ink-3)'}}>Profile cap reached ({cap}). {isSuper?'Raise your tier from Settings › Billing.':'Contact a Super Admin to add more client profiles.'}</div>
      )}
      <div style={{display:'flex',justifyContent:'flex-end',gap:10,borderTop:'1px solid var(--border-1)',paddingTop:14,marginTop:14}}>
        <Btn onClick={()=>set({overlay:null})}>Cancel</Btn>
        <Btn variant="primary" disabled={sel.length===0} onClick={doImport}>Import {sel.length>0?sel.length+' ':''}client{sel.length===1?'':'s'}</Btn>
      </div>
    </Modal>
  );
}

// 2A — Firm AI settings (Memory Files: Firm Soul / Compass / Playbook) / 2B.3 personal variant
const OB_FIRM_MEMORY = {
  'Firm Soul': [
    ['Mission & mandate','Why the firm exists.','We help maritime and defense clients turn federal policy shifts into protected funding and favorable language.'],
    ['Advocacy philosophy','How we win.','Relationship-first, bipartisan, always bringing members a credible local-jobs story.'],
    ['Core values','Non-negotiable principles.','Candor with clients, discretion on the Hill, never overpromise access.'],
    ['Ethics & compliance posture','LDA discipline, gift rules, conflicts.','Strict LDA quarterly filing; no gifts beyond de minimis; conflicts cleared before engagement.'],
    ['Bipartisan positioning & no-go list','Where we will and will not play.','We work both caucuses on appropriations; we decline tobacco and foreign-state principals.'],
  ],
  'Firm Compass': [
    ['3–5 year vision','Where the practice is going.','Become the go-to shop for shipyard and port-infrastructure appropriations by 2028.'],
    ['Book-of-business goals','Target client/sector mix.','Grow defense-industrial from 3 to 6 retainers; add two port authorities.'],
    ['Yearly themes','The throughline this year.','This year: ride the shipbuilding-supplemental cycle and deepen Senate Approps ties.'],
  ],
  'Firm Playbook': [
    ['How we run an engagement','Standard cadence and milestones.','Kickoff strategy memo in week 1; biweekly client calls; quarterly Hill-action review.'],
    ['Escalation paths','Who gets pulled in, when.','Partner joins any meeting with a full committee chair or when a client redline is at risk.'],
    ['What a good debrief looks like','The bar for a useful debrief.','Who was in the room, what they committed to, the ask we left, and the next touch date.'],
  ],
};

function AiSettingsOverlay({ S, set, firm }) {
  const [section, setSection] = React.useState('Firm Soul');
  if (firm) {
    const sections = Object.keys(OB_FIRM_MEMORY);
    const fields = OB_FIRM_MEMORY[section];
    return (
      <Modal title="Configure firm AI settings" onClose={()=>set({overlay:null})} width={660}>
        <div style={{fontSize:12.5,color:'var(--ink-2)',lineHeight:1.55,margin:'-2px 0 14px',textWrap:'pretty'}}>
          Firm knowledge that grounds Meri and the knowledge graph for everyone in {S.orgName}. Write in your own voice — the greyed hints show what belongs in each section. Individuals can layer personal preferences on top later.
        </div>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:16}}>
          <div style={{maxWidth:240,flex:1}}>
            <SelectInput options={sections} value={section} onChange={setSection}/>
          </div>
          <span style={{fontSize:11.5,color:'var(--ink-3)',fontFamily:'var(--font-mono)',letterSpacing:0}}>{sections.indexOf(section)+1} / {sections.length}</span>
        </div>
        <div style={{display:'grid',gap:18,maxHeight:'46vh',overflowY:'auto',paddingRight:4}}>
          {fields.map(([label,desc,eg])=>(
            <div key={label} style={{display:'grid',gap:6}}>
              <span style={{fontSize:13,fontWeight:600,color:'var(--ink-1)'}}>{label}</span>
              <span style={{fontSize:11.5,color:'var(--ink-3)',lineHeight:1.45}}>{desc} <span style={{fontStyle:'italic'}}>e.g. "{eg}"</span></span>
              <textarea rows={2} style={{...obInputStyle,resize:'vertical'}} placeholder="Write in your own voice…"></textarea>
            </div>
          ))}
        </div>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,borderTop:'1px solid var(--border-1)',paddingTop:14,marginTop:16}}>
          <Btn onClick={()=>set({overlay:null})}>Cancel</Btn>
          <Btn variant="primary" onClick={()=>set({taskAI:'done',overlay:null})} icon="Save">Save changes</Btn>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Personalize your Meri experience" onClose={()=>set({overlay:null})}>
      <div style={{display:'grid',gap:14}}>
        <Field label="Default tone"><SelectInput options={['Neutral / professional','Direct and brief','Warm and consultative','Formal']} value={S.aiTone||'Neutral / professional'} onChange={v=>set({aiTone:v})}/></Field>
        <Field label="Communication style">
          <div style={{display:'flex',gap:8}}>
            {['Bullets first','Narrative','Data-heavy'].map(o=>(
              <button key={o} onClick={()=>set({aiStyle:o})} style={{flex:1,padding:'7px 0',fontSize:12,fontWeight:600,fontFamily:'var(--font-sans)',cursor:'pointer',borderRadius:6,
                border:S.aiStyle===o?'1.5px solid var(--accent)':'1px solid var(--border-1)',
                background:S.aiStyle===o?'var(--accent-soft)':'#fff',color:S.aiStyle===o?'var(--accent-ink)':'var(--ink-2)'}}>{o}</button>
            ))}
          </div>
        </Field>
        <Field label="Restrictions" hint="Topics or actions Meri should avoid.">
          <textarea rows={2} style={{...obInputStyle,resize:'vertical'}} placeholder="e.g. no draft outreach without review"></textarea>
        </Field>
        <Field label="Custom instructions" optional>
          <textarea rows={2} style={{...obInputStyle,resize:'vertical'}} placeholder="Anything else Meri should know"></textarea>
        </Field>
        <div style={{display:'flex',justifyContent:'flex-end',gap:10,borderTop:'1px solid var(--border-1)',paddingTop:14}}>
          <Btn onClick={()=>set({overlay:null})}>Cancel</Btn>
          <Btn variant="primary" onClick={()=>set({taskAI:'done',overlay:null})}>Save Settings</Btn>
        </div>
      </div>
    </Modal>
  );
}

// 2A — Send team invites (final unlocked step)
function InvitesOverlay({ S, set, go }) {
  const [rows, setRows] = React.useState([{email:'omar.reyes@meridian-strategies.com',role:'Admin'},{email:'priya.shah@meridian-strategies.com',role:'Standard User'},{email:'',role:'Standard User'}]);
  const [sent, setSent] = React.useState(false);
  const valid = rows.filter(r=>r.email.includes('@'));
  const setRow = (i,patch)=>{const n=[...rows];n[i]={...n[i],...patch};setRows(n);};
  return (
    <Modal title="Invite your team" onClose={()=>set({overlay:null})} width={560}>
      {!sent ? (
        <div style={{display:'grid',gap:10}}>
          {rows.map((r,i)=>(
            <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 160px',gap:10}}>
              <TextInput placeholder="name@firm.com" value={r.email} onChange={e=>setRow(i,{email:e.target.value})}/>
              <SelectInput options={['Standard User','Admin']} value={r.role} onChange={v=>setRow(i,{role:v})}/>
            </div>
          ))}
          <div style={{display:'flex',gap:16,alignItems:'center'}}>
            <a href="#" onClick={e=>{e.preventDefault();setRows([...rows,{email:'',role:'Standard User'}]);}} style={{fontSize:12.5,color:'var(--accent)',fontWeight:600}}>+ Add another</a>
            <a href="#" onClick={e=>e.preventDefault()} style={{fontSize:12.5,color:'var(--accent)',display:'inline-flex',alignItems:'center',gap:5}}><Icon name="FileUp" size={12}/>Bulk CSV import</a>
          </div>
          <div style={{display:'flex',justifyContent:'flex-end',gap:10,borderTop:'1px solid var(--border-1)',paddingTop:14}}>
            <Btn onClick={()=>set({overlay:null})}>Cancel</Btn>
            <Btn variant="primary" disabled={valid.length===0} onClick={()=>{setSent(true);set({taskInvites:'done'});}}>Send {valid.length} Invite{valid.length===1?'':'s'}</Btn>
          </div>
        </div>
      ) : (
        <div style={{textAlign:'center',padding:'14px 0 4px'}}>
          <div style={{width:46,height:46,borderRadius:'50%',background:'var(--success-soft)',display:'grid',placeItems:'center',margin:'0 auto 14px'}}>
            <Icon name="Check" size={22} strokeWidth={2.6} style={{color:'var(--success)'}}/>
          </div>
          <b style={{fontSize:15}}>Invites sent</b>
          <p style={{margin:'6px 0 18px',fontSize:12.5,color:'var(--ink-2)'}}>{valid.length} teammates will get an email to join {S.orgName}. Each connects their own email and calendar on first login.</p>
          <Btn variant="primary" onClick={()=>{set({overlay:null});go('2b-gate');}} icon="ArrowRight" style={{width:'100%'}}>Continue to Capiro</Btn>
        </div>
      )}
    </Modal>
  );
}

// ── IT Admin path — same URL, single-task view ─────────────────────────────
function ItAdminView({ S, set }) {
  const [phase, setPhase] = React.useState(S.itConnected ? 'done' : 'idle'); // idle → connecting → done
  const connect = () => {
    setPhase('connecting');
    setTimeout(()=>{ setPhase('done'); set({itConnected:true}); }, 1600);
  };
  return (
    <ExtShell S={S}>
      <div style={{maxWidth:480,margin:'40px auto 0'}}>
        <Card style={{textAlign:'center',padding:'40px 36px'}}>
          {phase==='done' ? (
            <>
              <div style={{width:52,height:52,borderRadius:'50%',background:'var(--success-soft)',display:'grid',placeItems:'center',margin:'0 auto 18px'}}>
                <Icon name="Check" size={25} strokeWidth={2.6} style={{color:'var(--success)'}}/>
              </div>
              <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:25,letterSpacing:'-0.015em'}}>Connection verified</h1>
              <p style={{margin:'10px 0 0',fontSize:13.5,color:'var(--ink-2)',lineHeight:1.6}}>
                Your team can now connect their individual email and calendar.<br/><br/>
                <b style={{color:'var(--ink-1)'}}>You're all set — no further action needed.</b>
              </p>
            </>
          ) : (
            <>
              <div style={{width:52,height:52,borderRadius:'50%',background:'var(--accent-soft)',display:'grid',placeItems:'center',margin:'0 auto 18px'}}>
                <Icon name="Plug" size={23} style={{color:'var(--accent)'}}/>
              </div>
              <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:25,letterSpacing:'-0.015em',lineHeight:1.25}}>Connect {S.orgName}'s email to Capiro</h1>
              <p style={{margin:'10px 0 24px',fontSize:13,color:'var(--ink-2)',lineHeight:1.6,textWrap:'pretty'}}>
                Signing in with your org admin credentials will authorize all team members to connect their individual accounts.
              </p>
              {phase==='connecting' ? (
                <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:10,fontSize:13,color:'var(--ink-2)',padding:'12px 0'}}>
                  <Spinner size={16}/>Authorizing with your provider…
                </div>
              ) : (
                <div style={{display:'grid',gap:10}}>
                  <Btn variant="secondary" size="lg" onClick={connect} style={{width:'100%'}}>
                    <MsGlyph/> Connect with Microsoft
                  </Btn>
                  <Btn variant="secondary" size="lg" onClick={connect} style={{width:'100%'}}>
                    <GGlyph/> Connect with Google
                  </Btn>
                </div>
              )}
              <div style={{marginTop:18,fontSize:11.5,color:'var(--ink-3)',lineHeight:1.5}}>
                Org-wide grant only — Capiro never reads mailboxes until each user opts in individually.
              </div>
            </>
          )}
        </Card>
      </div>
    </ExtShell>
  );
}

// ── 2A.0 — Admin invite email → credential creation ────────────────────────
function AcceptInvite({ S, set, go }) {
  const [phase, setPhase] = React.useState('email'); // email → create
  const adminEmail = S.roleMode==='self' ? S.email : ((S.invites.find(v=>v.email)||{}).email || S.email);
  return (
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-canvas)'}}>
      <EnvBar url={phase==='email'?'mail — inbox':'onboarding.capiro.ai/accept-invite'}/>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',padding:'48px 40px 64px'}}>
        {phase==='email' ? (
          <div style={{width:'100%',maxWidth:520}}>
            <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:'var(--ink-3)',marginBottom:10,textAlign:'center'}}>The admin receives this email</div>
            <Card pad={0} style={{overflow:'hidden'}}>
              <div style={{padding:'14px 22px',borderBottom:'1px solid var(--border-1)',fontSize:12,color:'var(--ink-2)',display:'grid',gap:3}}>
                <span><b style={{color:'var(--ink-1)'}}>From:</b> Capiro &lt;hello@capiro.ai&gt;</span>
                <span><b style={{color:'var(--ink-1)'}}>To:</b> {adminEmail}</span>
                <span><b style={{color:'var(--ink-1)'}}>Subject:</b> You've been invited to set up {S.orgName} on Capiro</span>
              </div>
              <div style={{padding:'26px 22px',textAlign:'center'}}>
                <Wordmark/>
                <p style={{margin:'18px auto 6px',fontSize:14.5,fontWeight:600,maxWidth:360}}>You've been designated an admin for {S.orgName}.</p>
                <p style={{margin:'0 auto 20px',fontSize:12.5,color:'var(--ink-2)',lineHeight:1.6,maxWidth:380,textWrap:'pretty'}}>
                  Create your Capiro credentials to sign in and complete your firm's setup — email authorization, client import, and AI settings.
                </p>
                <Btn variant="primary" onClick={()=>setPhase('create')}>Create your Capiro account</Btn>
                <p style={{margin:'16px 0 0',fontSize:11,color:'var(--ink-4)'}}>This link expires in 7 days. Questions? support@capiro.ai</p>
              </div>
            </Card>
          </div>
        ) : (
          <div style={{width:'100%',maxWidth:400,marginTop:12}}>
            <div style={{textAlign:'center',marginBottom:18}}><Wordmark size={17}/></div>
            <Card style={{padding:'28px 26px'}}>
              <h2 style={{margin:'0 0 4px',fontFamily:'var(--font-serif)',fontWeight:500,fontSize:22,letterSpacing:'-0.015em'}}>Create your account</h2>
              <p style={{margin:'0 0 18px',fontSize:12.5,color:'var(--ink-2)'}}>One credential works for both the setup dashboard and the Capiro app.</p>
              <div style={{display:'grid',gap:13}}>
                <Field label="Email"><TextInput value={adminEmail} readOnly style={{color:'var(--ink-3)'}}/></Field>
                <Field label="Password"><TextInput type="password" defaultValue="••••••••••"/></Field>
                <Field label="Confirm password"><TextInput type="password" defaultValue="••••••••••"/></Field>
                <Btn variant="primary" onClick={()=>go('2a-dash')} style={{width:'100%',marginTop:2}}>Create account &amp; sign in</Btn>
              </div>
            </Card>
            <p style={{marginTop:14,fontSize:11.5,color:'var(--ink-3)',textAlign:'center',lineHeight:1.55}}>You'll land in the firm setup dashboard — the Capiro app unlocks once setup is complete.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Demo wrapper: the setup dashboard with all prior tasks complete and the
// unlocked "Invite your team" overlay open.
function Ext2AInvitesDemo({ S, set, go }) {
  const [ov, setOv] = React.useState('invites');
  const S2 = { ...S, taskEmail:'done', taskImport:'done', taskAI:'done', itConnected:true, overlay:ov };
  const set2 = (p) => {
    const patch = typeof p==='function' ? p(S2) : p;
    if (patch && 'overlay' in patch) setOv(patch.overlay);
    const rest = { ...patch }; delete rest.overlay; delete rest.taskEmail;
    if (Object.keys(rest).length) set(rest);
  };
  return <Ext2ADashboard S={S2} set={set2} go={go}/>;
}

function MsGlyph(){return(<svg width="15" height="15" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#F25022"/><rect x="11" y="1" width="9" height="9" fill="#7FBA00"/><rect x="1" y="11" width="9" height="9" fill="#00A4EF"/><rect x="11" y="11" width="9" height="9" fill="#FFB900"/></svg>);}
function GGlyph(){return(<svg width="15" height="15" viewBox="0 0 24 24"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.2 1.2-3.2 0-5.9-2.1-6.9-5l-3.9 3C3.2 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.1 14.4c-.2-.7-.4-1.5-.4-2.4s.1-1.7.4-2.4l-4-3C.4 8.2 0 10 0 12s.4 3.8 1.2 5.4l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l2.7-2.6C16.4 1.3 14 0 12 0 7.3 0 3.2 2.7 1.2 6.6l4 3c.9-2.8 3.6-4.9 6.8-4.9z"/></svg>);}

Object.assign(window, { ExtShell, Ext2ADashboard, ImportOverlay, AiSettingsOverlay, InvitesOverlay, ItAdminView, AcceptInvite, Ext2AInvitesDemo, Modal, MsGlyph, GGlyph, TaskCard, TaskStatus, OB_LDA_CLIENTS });
