// ── Flow 1 — Registration & Purchase (Environment 1) ───────────────────────
// Screens 1.1–1.10 + provisioning bridge. Each receives { S, set, go }.

const OB_TRIAL_CHARGE_DATE = 'August 1, 2026'; // day 31 from July 2, 2026

// 1.1 Landing
function F1Landing({ go }) {
  return (
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-canvas)'}}>
      <EnvBar url="capiro.com"/>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 40px'}}>
        <Wordmark/>
        <div style={{display:'flex',gap:10,alignItems:'center'}}>
          <Btn variant="ghost" size="sm">Sign in</Btn>
          <Btn variant="primary" size="sm" onClick={()=>go('f1-register')}>Get Started</Btn>
        </div>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',textAlign:'center',padding:'0 40px 80px'}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.1em',color:'var(--accent)',marginBottom:16}}>Government-affairs intelligence</div>
        <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:52,letterSpacing:'-0.02em',lineHeight:1.1,color:'var(--ink-1)',maxWidth:720,textWrap:'balance'}}>
          Every client. Every signal. One workspace.
        </h1>
        <p style={{margin:'18px 0 30px',fontSize:16,color:'var(--ink-2)',maxWidth:520,lineHeight:1.6,textWrap:'pretty'}}>
          Capiro tracks legislation, regulation, and stakeholder activity across your entire client portfolio — and briefs your team before it matters.
        </p>
        <Btn variant="primary" size="lg" onClick={()=>go('f1-register')} icon="ArrowRight">Get Started</Btn>
      </div>
    </div>
  );
}

// 1.2 Purchaser Registration
function F1Register({ S, set, go }) {
  return (
    <FunnelShell step={0}>
      <ScreenTitle kicker="Create your organization" title="Let's get your firm set up"
        sub="You're registering as the purchaser and billing contact for your organization."/>
      <Card>
        <div style={{display:'grid',gap:14}}>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="First name"><TextInput value={S.firstName} onChange={e=>set({firstName:e.target.value})}/></Field>
            <Field label="Last name"><TextInput value={S.lastName} onChange={e=>set({lastName:e.target.value})}/></Field>
          </div>
          <Field label="Work email"><TextInput value={S.email} onChange={e=>set({email:e.target.value})}/></Field>
          <Field label="Organization name"><TextInput value={S.orgName} onChange={e=>set({orgName:e.target.value})}/></Field>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Password"><TextInput type="password" defaultValue="••••••••••"/></Field>
            <Field label="Confirm password"><TextInput type="password" defaultValue="••••••••••"/></Field>
          </div>
          <Btn variant="primary" onClick={()=>go('f1-verify')} style={{marginTop:4,width:'100%'}}>Create Account</Btn>
        </div>
      </Card>
      <div style={{marginTop:14,fontSize:12,color:'var(--ink-3)',textAlign:'center',lineHeight:1.6}}>
        No platform account or role is created yet — that happens after checkout.<br/>
        Already have an account? <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>Sign in</a>
      </div>
    </FunnelShell>
  );
}

// 1.3 Email Verification
function F1Verify({ S, set, go }) {
  return (
    <FunnelShell step={1} maxWidth={460}>
      <Card style={{textAlign:'center',padding:'40px 36px'}}>
        <div style={{width:52,height:52,borderRadius:'50%',background:'var(--accent-soft)',display:'grid',placeItems:'center',margin:'0 auto 18px'}}>
          <Icon name="MailCheck" size={24} style={{color:'var(--accent)'}}/>
        </div>
        <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:26,letterSpacing:'-0.015em'}}>Check your inbox</h1>
        <p style={{margin:'10px 0 22px',fontSize:13.5,color:'var(--ink-2)',lineHeight:1.6}}>
          We sent a verification link to <b style={{color:'var(--ink-1)'}}>{S.email}</b>.<br/>
          You can't continue until your email is verified.
        </p>
        {!S.verified ? (
          <div style={{display:'grid',gap:10}}>
            <Btn variant="secondary" onClick={()=>set({verified:true})} icon="MousePointerClick">Verify email <span style={{fontWeight:400,color:'var(--ink-3)'}}>(simulate click in inbox)</span></Btn>
            <Btn variant="primary" disabled>Continue</Btn>
          </div>
        ) : (
          <div style={{display:'grid',gap:10}}>
            <div style={{display:'flex',alignItems:'center',justifyContent:'center',gap:7,fontSize:12.5,fontWeight:600,color:'var(--success)'}}>
              <Icon name="CircleCheck" size={15}/>Email verified
            </div>
            <Btn variant="primary" onClick={()=>go('f1-plan')}>Continue</Btn>
          </div>
        )}
        <div style={{marginTop:16,fontSize:12,color:'var(--ink-3)'}}>
          Didn't get it? <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>Resend link</a>
        </div>
      </Card>
    </FunnelShell>
  );
}

// 1.4 Plan Selection — Subscribe is the main CTA; trial is a quiet nudge below.
function F1Plan({ S, set, go }) {
  return (
    <FunnelShell step={2} maxWidth={560}>
      <ScreenTitle title="Choose how to start"/>
      <OptionCard selected={S.plan==='paid'} onClick={()=>set({plan:'paid'})}
        title="Subscribe Now" badge={<Tag tone="blue">Recommended</Tag>}
        price="$200 / profile · billed monthly · 10-profile minimum ($2,000/month)">
        Choose your client profile tier and get started with your full portfolio from day one.
        <ul style={{margin:'10px 0 0',padding:'0 0 0 16px',display:'grid',gap:4}}>
          <li>Pay by card, wire, or ACH</li>
          <li>Volume discounts available for large accounts</li>
          <li>Prices subject to change</li>
        </ul>
      </OptionCard>
      <div onClick={()=>set({plan:'trial'})} style={{display:'flex',gap:10,alignItems:'flex-start',cursor:'pointer',marginTop:14,padding:'12px 16px',borderRadius:8,
        border:S.plan==='trial'?'1.5px solid var(--border-strong)':'1px dashed var(--border-2)',
        background:S.plan==='trial'?'var(--bg-surface-2)':'transparent'}}>
        <span style={{width:14,height:14,borderRadius:'50%',flexShrink:0,marginTop:2,
          border:S.plan==='trial'?'4.5px solid var(--ink-2)':'1.5px solid var(--border-strong)',background:'#fff'}}></span>
        <div style={{fontSize:12.5,color:'var(--ink-2)',lineHeight:1.55}}>
          <b style={{color:'var(--ink-1)'}}>Just exploring? Start with a 30-day free trial.</b><br/>
          $0 today · 10 client profile limit · no user cap · converts to a subscription on day 31 unless you cancel.
        </div>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:20}}>
        <Btn variant="primary" disabled={!S.plan} onClick={()=>go('f1-legal')}>Continue</Btn>
      </div>
    </FunnelShell>
  );
}

// 1.5 Legal Agreements
const OB_TOS_TEXT = `1. ACCEPTANCE OF TERMS\nBy accessing or using the Capiro platform, you agree to be bound by these Terms of Service.\n\n2. USE OF SERVICE\nCapiro grants your organization a non-exclusive, non-transferable right to access the platform for internal business purposes.\n\n3. ACCOUNTS\nYou are responsible for maintaining the confidentiality of credentials and for all activity under your organization's accounts.\n\n4. DATA\nClient data you import remains yours. Capiro processes it solely to provide the service.\n\n5. ACCEPTABLE USE\nYou will not misuse the service, attempt unauthorized access, or resell access without written consent.\n\n6. TERMINATION\nEither party may terminate per the Subscription Agreement. Sections that by nature survive termination will survive.`;
const OB_MSA_TEXT = `SUBSCRIPTION AGREEMENT\n\n1. SUBSCRIPTION\nCapiro provides the platform on a per-client-profile subscription basis, at the tier selected at purchase.\n\n2. FEES & PAYMENT\nFees are billed monthly in advance. Trial accounts convert automatically on day 31 unless cancelled. Wire and ACH invoices are due on receipt.\n\n3. PROFILE CAPACITY\nYour organization may hold at most the number of active client profiles purchased. Capacity changes take effect on payment.\n\n4. SERVICE LEVELS\nCapiro targets 99.9% monthly availability, excluding scheduled maintenance.\n\n5. CONFIDENTIALITY\nEach party protects the other's confidential information with reasonable care.\n\n6. LIABILITY\nNeither party's aggregate liability exceeds fees paid in the trailing 12 months.`;

function LegalBlock({ title, text, checked, onChange, label, extra }) {
  return (
    <Card pad={0} style={{overflow:'hidden'}}>
      <div style={{padding:'12px 18px',borderBottom:'1px solid var(--border-1)',display:'flex',alignItems:'center',gap:8}}>
        <Icon name="ScrollText" size={15} style={{color:'var(--ink-3)'}}/>
        <b style={{fontSize:13.5}}>{title}</b>
        {extra && <span style={{marginLeft:'auto'}}>{extra}</span>}
      </div>
      <div style={{height:130,overflowY:'auto',padding:'12px 18px',background:'var(--bg-surface-2)',fontSize:11.5,lineHeight:1.65,color:'var(--ink-2)',whiteSpace:'pre-wrap',fontFamily:'var(--font-mono)',letterSpacing:0}}>{text}</div>
      <div style={{padding:'12px 18px',borderTop:'1px solid var(--border-1)'}}>
        <Checkbox checked={checked} onChange={onChange}>{label}</Checkbox>
      </div>
    </Card>
  );
}

function F1Legal({ S, set, go }) {
  const ok = S.tosChecked && S.msaChecked;
  return (
    <FunnelShell step={3} maxWidth={620}>
      <ScreenTitle title="Review and accept the agreements" sub="Both agreements must be accepted to continue. Acceptance is logged with a timestamp."/>
      <div style={{display:'grid',gap:16}}>
        <LegalBlock title="Terms of Service" text={OB_TOS_TEXT} checked={S.tosChecked}
          onChange={v=>set({tosChecked:v})} label={<span>I agree to the <b>Terms of Service</b></span>}/>
        <LegalBlock title="Subscription Agreement" text={OB_MSA_TEXT} checked={S.msaChecked}
          onChange={v=>set({msaChecked:v})} label={<span>I agree to the <b>SA</b></span>}
          extra={<a href="#" onClick={e=>e.preventDefault()} style={{fontSize:12,color:'var(--accent)',display:'inline-flex',alignItems:'center',gap:4}}><Icon name="Download" size={12}/>Download PDF</a>}/>
      </div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginTop:20}}>
        <span style={{fontSize:12,color:'var(--ink-3)'}}>Need custom terms? <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>Contact us</a></span>
        <Btn variant="primary" disabled={!ok} onClick={()=>go(S.plan==='paid'?'f1-pay-paid':'f1-pay-trial')}>Continue</Btn>
      </div>
    </FunnelShell>
  );
}

// 1.6a Trial — payment method on file (Card / Wire / ACH, matching 1.6b)
function F1PayTrial({ S, set, go }) {
  const tab = S.payMethod;
  const TabBtn = ({id,label}) => (
    <button onClick={()=>set({payMethod:id})} style={{flex:1,padding:'8px 0',fontSize:12.5,fontWeight:600,fontFamily:'var(--font-sans)',cursor:'pointer',
      border:'none',borderBottom:tab===id?'2px solid var(--accent)':'2px solid transparent',
      background:'transparent',color:tab===id?'var(--accent-ink)':'var(--ink-3)'}}>{label}</button>
  );
  return (
    <FunnelShell step={4} maxWidth={520}>
      <ScreenTitle kicker="Free trial" title="Add a payment method to start your trial"
        sub={<span>You won't be charged today. Your trial converts to a paid subscription on <b style={{color:'var(--ink-1)'}}>day 31</b> unless you cancel — that's when your selected method is first charged.</span>}/>
      <Card pad={0}>
        <div style={{display:'flex',borderBottom:'1px solid var(--border-1)',padding:'0 12px'}}>
          <TabBtn id="card" label="Card"/><TabBtn id="wire" label="Wire"/><TabBtn id="ach" label="ACH"/>
        </div>
        <div style={{padding:20}}>
          {tab==='card' && <>
            <CardFields/>
            <div style={{marginTop:12,fontSize:11.5,color:'var(--ink-3)',display:'flex',alignItems:'center',gap:6}}>
              <Icon name="Lock" size={11}/>Card stored securely — no charge until day 31.
            </div>
          </>}
          {tab==='wire' && <div style={{display:'grid',gap:12}}>
            <div style={{background:'var(--accent-soft)',borderRadius:6,padding:'12px 14px',fontSize:12.5,color:'var(--accent-ink)',lineHeight:1.55,display:'flex',gap:9}}>
              <Icon name="Landmark" size={16} style={{marginTop:1}}/>
              <span>No charge today. If your trial converts on day 31, bank wire instructions and an invoice are emailed to <b>{S.email}</b>. Cancel before then and nothing is billed.</span>
            </div>
            <Field label="Billing contact (for invoice)"><TextInput defaultValue={S.email}/></Field>
          </div>}
          {tab==='ach' && <div style={{display:'grid',gap:12}}>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
              <Field label="Routing number"><TextInput placeholder="021000021" defaultValue="021000021" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
              <Field label="Account number"><TextInput placeholder="000123456789" defaultValue="000123456789" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
            </div>
            <div style={{fontSize:11.5,color:'var(--ink-3)',display:'flex',gap:6}}><Icon name="Clock" size={12} style={{marginTop:1}}/>No charge today. If your trial converts on day 31, your bank account is debited then — ACH takes 1–3 business days to clear.</div>
          </div>}
          <Btn variant="primary" onClick={()=>go('f1-roles')} style={{width:'100%',marginTop:18}}>Start Free Trial</Btn>
        </div>
      </Card>
    </FunnelShell>
  );
}

// 1.6b Paid — profile tier & payment
function F1PayPaid({ S, set, go }) {
  const n = Math.max(10, S.profiles||10);
  const price = (n*200).toLocaleString();
  const tab = S.payMethod;
  const TabBtn = ({id,label}) => (
    <button onClick={()=>set({payMethod:id})} style={{flex:1,padding:'8px 0',fontSize:12.5,fontWeight:600,fontFamily:'var(--font-sans)',cursor:'pointer',
      border:'none',borderBottom:tab===id?'2px solid var(--accent)':'2px solid transparent',
      background:'transparent',color:tab===id?'var(--accent-ink)':'var(--ink-3)'}}>{label}</button>
  );
  return (
    <FunnelShell step={4} maxWidth={860}>
      <ScreenTitle kicker="Subscription" title="Choose your tier and payment method"/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1.2fr',gap:16,alignItems:'start'}}>
        <Card>
          <b style={{fontSize:13.5}}>Client profile tier</b>
          <div style={{margin:'14px 0 10px'}}>
            <Field label="Number of client profiles" hint="Minimum 10 profiles.">
              <TextInput type="number" min={10} value={S.profiles} onChange={e=>set({profiles:parseInt(e.target.value)||10})}
                style={{fontFamily:'var(--font-mono)',letterSpacing:0,width:120}}/>
            </Field>
          </div>
          <div style={{background:'var(--bg-sunken)',border:'1px solid var(--border-1)',borderRadius:6,padding:'12px 14px',fontFamily:'var(--font-mono)',fontSize:12.5,letterSpacing:0,color:'var(--ink-1)'}}>
            {n} profiles × $200 = <b>${price}/month</b>
          </div>
          {n<10 && <div style={{marginTop:8,fontSize:11.5,color:'var(--critical)'}}>Minimum is 10 profiles.</div>}
          <div style={{marginTop:12,fontSize:11.5,color:'var(--ink-3)',lineHeight:1.5}}>
            Volume discounts available for large accounts — <a href="#" onClick={e=>e.preventDefault()} style={{color:'var(--accent)'}}>contact sales</a>. Prices subject to change.
          </div>
        </Card>
        <Card pad={0}>
          <div style={{display:'flex',borderBottom:'1px solid var(--border-1)',padding:'0 12px'}}>
            <TabBtn id="card" label="Card"/><TabBtn id="wire" label="Wire"/><TabBtn id="ach" label="ACH"/>
          </div>
          <div style={{padding:20}}>
            {tab==='card' && <>
              <CardFields/>
              <div style={{marginTop:12,fontSize:11.5,color:'var(--ink-3)'}}>Your card is charged <b>${price}</b> immediately on subscribe.</div>
            </>}
            {tab==='wire' && <div style={{display:'grid',gap:12}}>
              <div style={{background:'var(--accent-soft)',borderRadius:6,padding:'12px 14px',fontSize:12.5,color:'var(--accent-ink)',lineHeight:1.55,display:'flex',gap:9}}>
                <Icon name="Landmark" size={16} style={{marginTop:1}}/>
                <span>Bank wire instructions will be emailed to <b>{S.email}</b> and an invoice for <b>${price}</b> is generated on submit. Your workspace provisions immediately; access locks if the invoice goes unpaid.</span>
              </div>
              <Field label="Billing contact (for invoice)"><TextInput defaultValue={S.email}/></Field>
            </div>}
            {tab==='ach' && <div style={{display:'grid',gap:12}}>
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
                <Field label="Routing number"><TextInput placeholder="021000021" defaultValue="021000021" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
                <Field label="Account number"><TextInput placeholder="000123456789" defaultValue="000123456789" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
              </div>
              <div style={{fontSize:11.5,color:'var(--ink-3)',display:'flex',gap:6}}><Icon name="Clock" size={12} style={{marginTop:1}}/>ACH debits take 1–3 business days to clear. Your workspace provisions immediately.</div>
            </div>}
            <Btn variant="primary" disabled={n<10} onClick={()=>go('f1-roles')} style={{width:'100%',marginTop:18}}>Subscribe — ${price}/month</Btn>
          </div>
        </Card>
      </div>
    </FunnelShell>
  );
}

// 1.7 Role Designation
function F1Roles({ S, set, go }) {
  const invites = S.invites;
  const setInvite = (i,patch) => { const next=[...invites]; next[i]={...next[i],...patch}; set({invites:next}); };
  const hasSuper = S.roleMode==='self' || invites.some(v=>v.role==='Super Admin' && v.email.includes('@'));
  return (
    <FunnelShell step={5} maxWidth={560}>
      <ScreenTitle title="Who will manage your organization's Capiro account?"
        sub="At least one Super Admin is required — this is the first platform account created."/>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12,marginBottom:16}}>
        <div style={{background:'var(--bg-surface-2)',border:'1px solid var(--border-1)',borderRadius:8,padding:'12px 14px'}}>
          <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:5}}><Icon name="ShieldCheck" size={14} style={{color:'var(--accent)'}}/><b style={{fontSize:12.5}}>Super Admin</b></div>
          <div style={{fontSize:11.5,color:'var(--ink-2)',lineHeight:1.55}}>Manages the entire firm on Capiro, <b>plus billing decisions and upgrades</b>.</div>
        </div>
        <div style={{background:'var(--bg-surface-2)',border:'1px solid var(--border-1)',borderRadius:8,padding:'12px 14px'}}>
          <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:5}}><Icon name="UserCog" size={14} style={{color:'var(--ink-3)'}}/><b style={{fontSize:12.5}}>Admin</b></div>
          <div style={{fontSize:11.5,color:'var(--ink-2)',lineHeight:1.55}}>Everything a Super Admin can do — <b>except billing</b>, which stays hidden.</div>
        </div>
      </div>
      <Card>
        <div style={{display:'flex',gap:0,border:'1px solid var(--border-1)',borderRadius:6,overflow:'hidden',marginBottom:18}}>
          {[['self',"I'll be the Super Admin"],['invite','Invite someone else']].map(([id,label])=>(
            <button key={id} onClick={()=>set({roleMode:id})} style={{flex:1,padding:'9px 0',fontSize:12.5,fontWeight:600,fontFamily:'var(--font-sans)',cursor:'pointer',border:'none',
              background:S.roleMode===id?'var(--accent)':'#fff',color:S.roleMode===id?'#fff':'var(--ink-2)'}}>{label}</button>
          ))}
        </div>
        {S.roleMode==='self' ? (
          <div style={{display:'flex',gap:10,alignItems:'center',background:'var(--bg-surface-2)',border:'1px solid var(--border-1)',borderRadius:6,padding:'12px 14px'}}>
            <span style={{width:30,height:30,borderRadius:'50%',background:'linear-gradient(135deg,#2A57CE,#1A3F9F)',color:'#fff',display:'grid',placeItems:'center',fontSize:11,fontWeight:600,fontFamily:'var(--font-mono)'}}>{(S.firstName[0]||'')+(S.lastName[0]||'')}</span>
            <div style={{flex:1}}>
              <div style={{fontSize:13,fontWeight:600}}>{S.firstName} {S.lastName}</div>
              <div style={{fontSize:11.5,color:'var(--ink-3)'}}>{S.email}</div>
            </div>
            <Tag tone="blue">Super Admin</Tag>
          </div>
        ) : (
          <div style={{display:'grid',gap:10}}>
            {invites.map((v,i)=>(
              <div key={i} style={{display:'grid',gridTemplateColumns:'1fr 150px',gap:10}}>
                <TextInput placeholder="name@firm.com" value={v.email} onChange={e=>setInvite(i,{email:e.target.value})}/>
                <SelectInput options={['Super Admin','Admin']} value={v.role} onChange={r=>setInvite(i,{role:r})}/>
              </div>
            ))}
            <a href="#" onClick={e=>{e.preventDefault();set({invites:[...invites,{email:'',role:'Admin'}]});}}
              style={{fontSize:12.5,color:'var(--accent)',fontWeight:600}}>+ Add another</a>
            {!hasSuper && <div style={{fontSize:11.5,color:'var(--critical)',display:'flex',gap:6,alignItems:'center'}}><Icon name="TriangleAlert" size={12}/>Designate at least one Super Admin with a valid email.</div>}
          </div>
        )}
        <div style={{marginTop:16,fontSize:11.5,color:'var(--ink-3)',lineHeight:1.5,background:'var(--bg-sunken)',borderRadius:6,padding:'10px 12px',display:'flex',gap:8}}>
          <Icon name="Info" size={13} style={{marginTop:1,flexShrink:0}}/>
          Super Admin is the only role that can purchase or upgrade client profiles.
        </div>
        <Btn variant="primary" disabled={!hasSuper} onClick={()=>go('f1-import')} style={{width:'100%',marginTop:16}}>Continue</Btn>
      </Card>
      <div style={{marginTop:16,background:'var(--accent-soft)',border:'1px solid var(--accent)',borderRadius:8,padding:'14px 16px',display:'flex',gap:11}}>
        <Icon name="Users" size={17} style={{color:'var(--accent-ink)',marginTop:1,flexShrink:0}}/>
        <div style={{fontSize:13,color:'var(--accent-ink)',lineHeight:1.55,textWrap:'pretty'}}>
          <b>Invite the people who will set up your firm on Capiro.</b> These admins get access first — they authorize your firm's email, import your clients, and configure firm AI settings. Only once that firm-level setup is done is the rest of your team invited to log in.
        </div>
      </div>
    </FunnelShell>
  );
}

// 1.8 Client Import Preference
function F1Import({ S, set, go }) {
  return (
    <FunnelShell step={6} maxWidth={720}>
      <ScreenTitle title="How would you like to bring in your clients?"/>
      <div style={{display:'flex',gap:16,alignItems:'stretch'}}>
        <OptionCard selected={S.importMode==='self'} onClick={()=>set({importMode:'self'})} title="Self-service">
          Import your client portfolio yourself via CSV, CRM sync, or manually. Available immediately in your setup dashboard.
        </OptionCard>
        <OptionCard selected={S.importMode==='managed'} onClick={()=>set({importMode:'managed'})} title="Capiro-managed" badge={<Tag tone="blue">White-glove</Tag>}>
          Our team handles it for you. We'll reach out within one business day to collect your portfolio.
        </OptionCard>
      </div>
      <div style={{display:'flex',justifyContent:'flex-end',marginTop:20}}>
        <Btn variant="primary" disabled={!S.importMode} onClick={()=>go('f1-org')}>Continue</Btn>
      </div>
    </FunnelShell>
  );
}

// 1.9 Org & Tenant Setup
function F1Org({ S, set, go }) {
  return (
    <FunnelShell step={7} maxWidth={620}>
      <ScreenTitle title="Set up your workspace" sub="This is what we need to provision your firm's instance."/>
      <Card>
        <div style={{display:'grid',gap:14}}>
          <Field label="Firm legal name"><TextInput value={S.orgName} onChange={e=>set({orgName:e.target.value})}/></Field>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Industry vertical"><SelectInput placeholder="Select…" options={['Government affairs','Law firm','Defense & aerospace','Healthcare','Energy','Trade association']} value={S.vertical} onChange={v=>set({vertical:v})}/></Field>
            <Field label="Approximate team size"><SelectInput placeholder="Select…" options={['1–10','11–50','51–200','200+']} value={S.teamSize} onChange={v=>set({teamSize:v})}/></Field>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <Field label="Timezone"><SelectInput placeholder="Select…" options={['America/New_York (ET)','America/Chicago (CT)','America/Denver (MT)','America/Los_Angeles (PT)']} value={S.tz} onChange={v=>set({tz:v})}/></Field>
            <Field label="Default locale / currency" optional><SelectInput options={['en-US · USD','en-GB · GBP','fr-CA · CAD']} value={S.locale||'en-US · USD'} onChange={v=>set({locale:v})}/></Field>
          </div>
          <Field label="Business address">
            <div style={{display:'grid',gap:8}}>
              <TextInput placeholder="Street" defaultValue="1401 K Street NW, Suite 900"/>
              <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr',gap:8}}>
                <TextInput placeholder="City" defaultValue="Washington"/>
                <TextInput placeholder="State" defaultValue="DC"/>
                <TextInput placeholder="ZIP" defaultValue="20005"/>
              </div>
            </div>
          </Field>
          <Field label="Logo" optional>
            <div style={{border:'1.5px dashed var(--border-strong)',borderRadius:6,padding:'18px 14px',textAlign:'center',fontSize:12,color:'var(--ink-3)',background:'var(--bg-surface-2)',cursor:'pointer'}}>
              <Icon name="ImageUp" size={17} style={{color:'var(--ink-4)',marginBottom:4}}/><br/>
              Drag and drop your logo, or <span style={{color:'var(--accent)',fontWeight:600}}>browse</span>
            </div>
          </Field>
          <div style={{border:'1.5px solid var(--accent)',background:'var(--accent-soft)',borderRadius:8,padding:'14px 16px'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
              <Icon name="ShieldCheck" size={15} style={{color:'var(--accent-ink)'}}/>
              <b style={{fontSize:12.5,color:'var(--accent-ink)'}}>IT Admin email address</b>
              <Tag tone="blue">Important</Tag>
            </div>
            <p style={{margin:'0 0 10px',fontSize:12,color:'var(--accent-ink)',lineHeight:1.55,textWrap:'pretty'}}>
              An IT admin at your firm must approve email permissions before any user can personally connect their inbox. You can do this step later, but it is <b>required before use</b>.
            </p>
            <TextInput value={S.itEmail} onChange={e=>set({itEmail:e.target.value})} placeholder="it@yourfirm.com" style={{background:'#fff'}}/>
          </div>
          <Btn variant="primary" disabled={!S.orgName} onClick={()=>go('f1-confirm')} style={{width:'100%',marginTop:4}}>Finish Setup</Btn>
        </div>
      </Card>
    </FunnelShell>
  );
}

// 1.10 Confirmation + provisioning bridge
function F1Confirm({ S, go }) {
  const [phase, setPhase] = React.useState(0); // 0..3 = bridge lines, 4 = revealed
  React.useEffect(()=>{
    const t = [setTimeout(()=>setPhase(1),900), setTimeout(()=>setPhase(2),1800),
               setTimeout(()=>setPhase(3),2700), setTimeout(()=>setPhase(4),3400)];
    return ()=>t.forEach(clearTimeout);
  },[]);
  const lines = [['Creating workspace…','Done'],['Running health check…','Stable'],['Sending invites…','Sent']];
  const admins = S.roleMode==='self' ? [`${S.email} (Super Admin)`] : S.invites.filter(v=>v.email).map(v=>`${v.email} (${v.role})`);
  const price = (Math.max(10,S.profiles)*200).toLocaleString();
  const receipt = S.plan==='trial'
    ? <>$0 charged today · Trial begins when firm setup completes · then <b>$2,000/mo</b> · {S.payMethod==='card'?'Card ending 4242':S.payMethod==='wire'?'Billed by wire':'Billed by ACH'}</>
    : S.payMethod==='card'
      ? <>Receipt: <b>${price}</b> charged · July 2, 2026 · Card ending 4242</>
      : <>Invoice sent to <b>{S.email}</b> · Amount due: <b>${price}</b> · {S.payMethod==='wire'?'Wire instructions emailed':'ACH debit initiated — 1–3 days to clear'}</>;
  return (
    <FunnelShell step={8} maxWidth={560}>
      <Card style={{textAlign:'center',padding:'40px 36px'}}>
        {phase<4 ? (
          <>
            <div style={{width:52,height:52,borderRadius:'50%',background:'var(--accent-soft)',display:'grid',placeItems:'center',margin:'0 auto 20px'}}>
              <Spinner size={22}/>
            </div>
            <h1 style={{margin:'0 0 22px',fontFamily:'var(--font-serif)',fontWeight:500,fontSize:24,letterSpacing:'-0.015em'}}>Provisioning your workspace</h1>
            <div style={{display:'grid',gap:10,maxWidth:320,margin:'0 auto',textAlign:'left'}}>
              {lines.map(([label,done],i)=>(
                <div key={i} style={{display:'flex',alignItems:'center',gap:10,fontSize:13,color:phase>i?'var(--ink-1)':'var(--ink-3)'}}>
                  {phase>i ? <Icon name="CircleCheck" size={16} style={{color:'var(--success)'}}/> : phase===i ? <Spinner/> : <span style={{width:16,height:16,borderRadius:'50%',border:'1.5px solid var(--border-strong)',display:'inline-block'}}></span>}
                  <span style={{flex:1}}>{label}</span>
                  {phase>i && <span style={{fontSize:11.5,fontWeight:700,color:'var(--success)'}}>✓ {done}</span>}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div style={{width:52,height:52,borderRadius:'50%',background:'var(--success-soft)',display:'grid',placeItems:'center',margin:'0 auto 18px'}}>
              <Icon name="Check" size={26} strokeWidth={2.6} style={{color:'var(--success)'}}/>
            </div>
            <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:26,letterSpacing:'-0.015em'}}>{S.plan==='trial'?'Your workspace is live.':'Payment confirmed — your workspace is live.'}</h1>
            <p style={{margin:'8px 0 22px',fontSize:13,color:'var(--ink-2)',lineHeight:1.55}}>Your firm's platform is created at <b style={{fontFamily:'var(--font-mono)',letterSpacing:0,fontSize:12.5}}>{S.slug}.capiro.ai</b> — but setup isn't finished. Your admins take it from here.{S.plan==='trial' && <><br/>Your <b style={{color:'var(--ink-1)'}}>30-day free trial begins the day your firm finishes setting up its workspace</b> — not today.</>}</p>
            <div style={{display:'grid',gap:10,textAlign:'left'}}>
              <InfoBlock icon="Server" title="Platform created" tag={<Tag tone="success">Ready</Tag>}>
                Workspace created and health check passed.
              </InfoBlock>
              <InfoBlock icon="Send" title="Admin invites sent">
                Invites sent to: {admins.join(' · ')}{S.itEmail?<><br/>IT Admin invite sent to <b>{S.itEmail}</b></>:null}<br/>
                <span style={{color:'var(--ink-3)'}}>Each admin gets an email to create their Capiro credentials and sign in — they'll land in the firm setup dashboard.</span>
              </InfoBlock>
              <InfoBlock icon="ReceiptText" title={S.plan==='trial'?'Trial billing':'Payment'}>
                {receipt}
              </InfoBlock>
              <div style={{background:'var(--bg-sunken)',border:'1px solid var(--border-1)',borderRadius:6,padding:'12px 14px'}}>
                <b style={{fontSize:11,textTransform:'uppercase',letterSpacing:'0.06em',color:'var(--ink-3)'}}>What happens next</b>
                <ol style={{margin:'8px 0 0',padding:'0 0 0 18px',fontSize:12,color:'var(--ink-2)',lineHeight:1.7}}>
                  <li>Admins create credentials and sign in to the setup dashboard</li>
                  <li>Firm-level setup: email authorization, client import, AI settings</li>
                  <li>The whole team is invited to log in to Capiro</li>
                </ol>
              </div>
            </div>
            <Btn variant="primary" onClick={()=>go('2a-accept')} style={{width:'100%',marginTop:20}} icon="ArrowRight">
              Demo: open the admin's invite email
            </Btn>
          </>
        )}
      </Card>
    </FunnelShell>
  );
}

function InfoBlock({ icon, title, tag, children }) {
  return (
    <div style={{display:'flex',gap:12,background:'var(--bg-surface-2)',border:'1px solid var(--border-1)',borderRadius:6,padding:'12px 14px'}}>
      <Icon name={icon} size={16} style={{color:'var(--ink-3)',marginTop:1}}/>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:2}}>
          <b style={{fontSize:12.5}}>{title}</b>{tag}
        </div>
        <div style={{fontSize:12,color:'var(--ink-2)',lineHeight:1.55,overflowWrap:'break-word'}}>{children}</div>
      </div>
    </div>
  );
}

Object.assign(window, { F1Landing, F1Register, F1Verify, F1Plan, F1Legal, F1PayTrial, F1PayPaid, F1Roles, F1Import, F1Org, F1Confirm, InfoBlock, OB_TRIAL_CHARGE_DATE });
