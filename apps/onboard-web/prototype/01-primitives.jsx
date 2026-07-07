// ── Capiro Onboarding Prototype — shared primitives ────────────────────────

function Icon({ name, size=16, strokeWidth=1.8, style }) {
  const node = (window.lucide && window.lucide.icons && window.lucide.icons[name]) || null;
  if (!node) return null;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round"
      style={{ flexShrink:0, ...style }}>
      {(node[2]||[]).map((c,i) => React.createElement(c[0],{key:i,...c[1]}))}
    </svg>
  );
}

function Wordmark({ dark=false, size=15 }) {
  const ring = dark ? '#cfc9bd' : '#4F525A';
  return (
    <span style={{display:'inline-flex',alignItems:'center',gap:9}}>
      <span style={{width:size*1.45,height:size*1.45,borderRadius:'50%',border:`2px solid ${ring}`,position:'relative',display:'inline-block',flexShrink:0}}>
        <span style={{position:'absolute',left:'50%',top:'50%',width:size*0.6,height:1.6,background:ring,transformOrigin:'left',transform:'rotate(-38deg)'}}></span>
      </span>
      <b style={{fontSize:size,color:dark?'#fff':'var(--ink-1)',fontWeight:600,letterSpacing:'-0.01em'}}>Capiro</b>
    </span>
  );
}

// Faux browser chrome communicating which of the 3 environments we're on.
function EnvBar({ url }) {
  return (
    <div style={{height:34,background:'#E3DED2',borderBottom:'1px solid var(--border-strong)',display:'flex',alignItems:'center',gap:8,padding:'0 14px',flexShrink:0}}>
      <span style={{display:'flex',gap:5}}>
        {['#D9534F','#E8B93E','#5BB65F'].map((c,i)=><span key={i} style={{width:9,height:9,borderRadius:'50%',background:c,opacity:0.75}}></span>)}
      </span>
      <span style={{flex:1,maxWidth:460,margin:'0 auto',background:'rgba(255,255,255,0.75)',border:'1px solid var(--border-2)',borderRadius:6,height:22,display:'flex',alignItems:'center',gap:6,padding:'0 10px',fontSize:11,color:'var(--ink-2)',fontFamily:'var(--font-mono)',letterSpacing:0}}>
        <Icon name="Lock" size={10} style={{color:'var(--ink-3)'}}/>{url}
      </span>
      <span style={{width:46}}></span>
    </div>
  );
}

function Btn({ variant='secondary', size, disabled, onClick, children, style, icon }) {
  const base = {
    fontFamily:'var(--font-sans)', fontSize:size==='sm'?12:13.5, fontWeight:600, letterSpacing:'-0.005em',
    padding:size==='sm'?'5px 11px':size==='lg'?'10px 20px':'8px 16px', borderRadius:6, cursor:disabled?'not-allowed':'pointer',
    display:'inline-flex', alignItems:'center', justifyContent:'center', gap:7, border:'1px solid transparent',
    opacity:disabled?0.45:1, transition:'background 0.12s ease',
  };
  const variants = {
    primary:   { background:'var(--accent)', color:'#fff', borderColor:'var(--accent)' },
    secondary: { background:'#fff', color:'var(--ink-1)', borderColor:'var(--border-1)' },
    ghost:     { background:'transparent', color:'var(--ink-2)' },
    danger:    { background:'#fff', color:'var(--critical)', borderColor:'var(--border-1)' },
  };
  return (
    <button disabled={disabled} onClick={disabled?undefined:onClick} style={{...base,...variants[variant],...style}}>
      {icon && <Icon name={icon} size={size==='sm'?13:15}/>}{children}
    </button>
  );
}

function Field({ label, hint, optional, children, style }) {
  return (
    <label style={{display:'flex',flexDirection:'column',gap:5,...style}}>
      <span style={{fontSize:12,fontWeight:600,color:'var(--ink-2)',display:'flex',gap:6,alignItems:'baseline'}}>
        {label}{optional && <span style={{fontWeight:400,color:'var(--ink-3)',fontSize:11}}>optional</span>}
      </span>
      {children}
      {hint && <span style={{fontSize:11.5,color:'var(--ink-3)',lineHeight:1.45}}>{hint}</span>}
    </label>
  );
}

const obInputStyle = {
  background:'var(--bg-sunken)', border:'1px solid var(--border-1)', borderRadius:6,
  padding:'8px 11px', fontSize:13.5, fontFamily:'var(--font-sans)', color:'var(--ink-1)',
  outline:'none', width:'100%', letterSpacing:'-0.005em',
};

function TextInput(props) {
  const [focus,setFocus] = React.useState(false);
  return <input {...props} onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)}
    style={{...obInputStyle, ...(focus?{boxShadow:'0 0 0 3px var(--accent-glow)',borderColor:'var(--accent)',background:'#fff'}:{}), ...props.style}} />;
}

function SelectInput({ options, value, onChange, placeholder, style }) {
  return (
    <select value={value||''} onChange={e=>onChange && onChange(e.target.value)}
      style={{...obInputStyle, appearance:'auto', color:value?'var(--ink-1)':'var(--ink-3)', ...style}}>
      {placeholder && <option value="" disabled>{placeholder}</option>}
      {options.map(o=><option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Checkbox({ checked, onChange, children }) {
  return (
    <label style={{display:'flex',gap:9,alignItems:'flex-start',cursor:'pointer',fontSize:13,color:'var(--ink-1)',lineHeight:1.5}}>
      <span onClick={e=>{e.preventDefault();onChange(!checked);}}
        style={{width:16,height:16,borderRadius:4,marginTop:1,flexShrink:0,display:'grid',placeItems:'center',
          border:checked?'1px solid var(--accent)':'1px solid var(--border-strong)',
          background:checked?'var(--accent)':'#fff'}}>
        {checked && <Icon name="Check" size={11} strokeWidth={3} style={{color:'#fff'}}/>}
      </span>
      <span onClick={e=>{e.preventDefault();onChange(!checked);}}>{children}</span>
    </label>
  );
}

// 11px uppercase severity tag
function Tag({ tone='neutral', children }) {
  const tones = {
    neutral: { bg:'var(--bg-sunken)', fg:'var(--ink-2)', bd:'var(--border-1)' },
    blue:    { bg:'var(--accent-soft)', fg:'var(--accent-ink)', bd:'transparent' },
    success: { bg:'var(--success-soft)', fg:'var(--success)', bd:'transparent' },
    critical:{ bg:'var(--critical-soft)', fg:'var(--critical)', bd:'transparent' },
    notable: { bg:'var(--notable-soft)', fg:'var(--notable)', bd:'transparent' },
  }[tone];
  return (
    <span style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.05em',
      background:tones.bg,color:tones.fg,border:`1px solid ${tones.bd}`,borderRadius:4,padding:'2px 7px',whiteSpace:'nowrap',display:'inline-flex',alignItems:'center',gap:5}}>
      {children}
    </span>
  );
}

function Card({ children, style, pad=24 }) {
  return (
    <div style={{background:'#fff',border:'1px solid var(--border-1)',borderRadius:8,
      boxShadow:'0 1px 2px rgba(21,22,26,0.04)',padding:pad,...style}}>
      {children}
    </div>
  );
}

// Radio-select option card (plan selection, import preference)
function OptionCard({ selected, onClick, title, price, children, badge }) {
  return (
    <div onClick={onClick} style={{flex:1,cursor:'pointer',background:'#fff',borderRadius:8,padding:'20px 20px 18px',position:'relative',
      border:selected?'1.5px solid var(--accent)':'1px solid var(--border-1)',
      boxShadow:selected?'0 0 0 3px var(--accent-glow)':'0 1px 2px rgba(21,22,26,0.04)',
      margin:selected?0:'0.5px'}}>
      <div style={{display:'flex',alignItems:'flex-start',gap:10,marginBottom:8}}>
        <span style={{width:16,height:16,borderRadius:'50%',flexShrink:0,marginTop:2,display:'grid',placeItems:'center',
          border:selected?'5px solid var(--accent)':'1.5px solid var(--border-strong)',background:'#fff'}}></span>
        <div style={{flex:1}}>
          <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <b style={{fontSize:15,letterSpacing:'-0.01em',color:'var(--ink-1)'}}>{title}</b>
            {badge}
          </div>
          {price && <div style={{fontFamily:'var(--font-mono)',fontSize:12,color:'var(--ink-2)',marginTop:3,letterSpacing:0}}>{price}</div>}
        </div>
      </div>
      <div style={{fontSize:12.5,color:'var(--ink-2)',lineHeight:1.55,paddingLeft:26}}>{children}</div>
    </div>
  );
}

// Flow-1 funnel step indicator
const OB_F1_STEPS = ['Account','Verify','Plan','Legal','Billing','Admins','Clients','Org','Done'];
function StepRail({ current }) {
  return (
    <div style={{display:'flex',alignItems:'center',gap:0}}>
      {OB_F1_STEPS.map((s,i)=>(
        <React.Fragment key={s}>
          {i>0 && <span style={{width:22,height:1,background:i<=current?'var(--accent)':'var(--border-2)'}}></span>}
          <span style={{display:'flex',alignItems:'center',gap:5}}>
            <span style={{width:15,height:15,borderRadius:'50%',display:'grid',placeItems:'center',fontSize:8.5,fontWeight:700,fontFamily:'var(--font-mono)',
              background:i<current?'var(--accent)':i===current?'#fff':'transparent',
              border:i===current?'1.5px solid var(--accent)':i<current?'1px solid var(--accent)':'1px solid var(--border-strong)',
              color:i<current?'#fff':i===current?'var(--accent)':'var(--ink-3)'}}>
              {i<current?<Icon name="Check" size={8} strokeWidth={3.4}/>:i+1}
            </span>
            <span style={{fontSize:10.5,fontWeight:i===current?700:500,color:i===current?'var(--ink-1)':i<current?'var(--ink-2)':'var(--ink-4)',letterSpacing:'0.01em'}}>{s}</span>
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

// Funnel page shell — Environment 1 (registration, no sidebar)
function FunnelShell({ step, url='app.capiro.ai/register', children, maxWidth=520 }) {
  return (
    <div style={{minHeight:'100vh',display:'flex',flexDirection:'column',background:'var(--bg-canvas)'}}>
      <EnvBar url={url}/>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'18px 40px 0',flexWrap:'wrap',gap:12}}>
        <Wordmark/>
        {step!=null && <StepRail current={step}/>}
        <span style={{width:70}}></span>
      </div>
      <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',padding:'44px 40px 64px'}}>
        <div style={{width:'100%',maxWidth}}>{children}</div>
      </div>
    </div>
  );
}

function ScreenTitle({ kicker, title, sub }) {
  return (
    <div style={{marginBottom:22}}>
      {kicker && <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:'0.08em',color:'var(--accent)',marginBottom:8}}>{kicker}</div>}
      <h1 style={{margin:0,fontFamily:'var(--font-serif)',fontWeight:500,fontSize:28,letterSpacing:'-0.015em',color:'var(--ink-1)',lineHeight:1.2}}>{title}</h1>
      {sub && <p style={{margin:'8px 0 0',fontSize:13.5,color:'var(--ink-2)',lineHeight:1.55,textWrap:'pretty'}}>{sub}</p>}
    </div>
  );
}

function Spinner({ size=14, color='var(--accent)' }) {
  return <span style={{width:size,height:size,borderRadius:'50%',flexShrink:0,display:'inline-block',
    border:`2px solid ${color}`,borderTopColor:'transparent',animation:'ob-spin 0.7s linear infinite'}}></span>;
}

// Simulated card fields (shared by 1.6a / 1.6b / upgrade modal)
function CardFields() {
  return (
    <div style={{display:'grid',gridTemplateColumns:'1fr',gap:12}}>
      <Field label="Card number">
        <div style={{position:'relative'}}>
          <TextInput placeholder="1234 5678 9012 3456" defaultValue="4242 4242 4242 4242" style={{fontFamily:'var(--font-mono)',letterSpacing:0,paddingRight:38}}/>
          <Icon name="CreditCard" size={15} style={{position:'absolute',right:12,top:10,color:'var(--ink-3)'}}/>
        </div>
      </Field>
      <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:12}}>
        <Field label="Expiry"><TextInput placeholder="MM / YY" defaultValue="09 / 28" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
        <Field label="CVC"><TextInput placeholder="123" defaultValue="314" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
        <Field label="ZIP"><TextInput placeholder="20001" defaultValue="20001" style={{fontFamily:'var(--font-mono)',letterSpacing:0}}/></Field>
      </div>
    </div>
  );
}

Object.assign(window, { Icon, Wordmark, EnvBar, Btn, Field, TextInput, SelectInput, Checkbox, Tag, Card,
  OptionCard, StepRail, FunnelShell, ScreenTitle, Spinner, CardFields, obInputStyle });
