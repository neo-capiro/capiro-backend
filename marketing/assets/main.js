/* Capiro marketing site — shared behavior.
   Loaded on every page via <script src="/assets/main.js">.
   Navigation is now real <a href> links (no client-side router / showPage).
   Page-specific behavior (e.g. the Solutions industry tabs + pathway map)
   lives inline in that page's template. */

function toggleNav(){var l=document.getElementById('navLinks'),b=document.getElementById('navBurger');if(!l)return;var open=l.classList.toggle('open');if(b){b.classList.toggle('open',open);b.setAttribute('aria-expanded',open?'true':'false');}}
function closeNav(){var l=document.getElementById('navLinks'),b=document.getElementById('navBurger');if(l)l.classList.remove('open');if(b){b.classList.remove('open');b.setAttribute('aria-expanded','false');}}

/* ---- Home nav (only present on /, which ships its own transparent-over-hero
   nav from templates/header-home.html). Solid state kicks in past 90px. ---- */
(function(){
  var nav=document.getElementById('siteNav');
  if(!nav)return;
  var on=false;
  function sync(){
    var s=window.scrollY>90;
    if(s!==on){on=s;nav.classList.toggle('is-scrolled',s);}
  }
  window.addEventListener('scroll',sync,{passive:true});
  sync();
  // The nav wraps to two rows on narrow viewports, so its height is not fixed.
  // Publish it so the hero's corner brackets can sit below it at any width.
  function measure(){
    document.documentElement.style.setProperty('--nav-h',nav.offsetHeight+'px');
  }
  measure();
  window.addEventListener('resize',measure,{passive:true});
  if(window.ResizeObserver)new ResizeObserver(measure).observe(nav);
})();

/* ---- Featured-tools rail (home only) ---- */
function scrollRail(dir){
  var el=document.querySelector('[data-rail="workflow"]');
  if(el)el.scrollBy({left:dir*Math.max(340,el.clientWidth*0.8),behavior:'smooth'});
}

/* ---- Insights feed (only acts when #insights-grid exists, i.e. /insights) ---- */
var _insightsLoaded=false;
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function attrEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}
function decodeEntities(s){var t=document.createElement('textarea');t.innerHTML=(s==null?'':s);return t.value;}
function fmtDate(iso){if(!iso)return'';var d=new Date(iso);if(isNaN(d.getTime()))return'';return d.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'});}
function renderInsightCard(it){
  var title=esc(decodeEntities(it.title||''));
  var desc=esc(decodeEntities(it.description||''));
  var date=fmtDate(it.pubDate);
  var link=attrEsc(it.link||'#');
  var thumb=it.thumbnail?'<img class="ins-thumb" loading="lazy" decoding="async" alt="" src="'+attrEsc(it.thumbnail)+'">':'';
  return '<a class="ins-card" href="'+link+'" target="_blank" rel="noopener">'+thumb+'<div class="ins-card-body">'+(date?'<div class="ins-date">'+date+'</div>':'')+'<div class="ins-title">'+title+'</div>'+(desc?'<p class="ins-excerpt">'+desc+'</p>':'')+'<span class="ins-readmore">Read on Substack &rarr;</span></div></a>';
}
function showInsightsFallback(){
  var grid=document.getElementById('insights-grid');
  var status=document.getElementById('insights-status');
  if(grid)grid.style.display='none';
  if(status){status.innerHTML='New issues of <strong style="color:var(--white);font-weight:500;">The Cycle</strong> appear here as they publish. <a href="https://capirohq.substack.com" target="_blank" rel="noopener" style="color:var(--blue-bright);text-decoration:none;">Read the latest on Substack &rarr;</a>';status.style.display='block';}
}
function loadInsights(){
  if(_insightsLoaded)return;_insightsLoaded=true;
  var grid=document.getElementById('insights-grid');
  var status=document.getElementById('insights-status');
  if(!grid)return;
  fetch('https://app.capiro.ai/api/insights',{headers:{'Accept':'application/json'}})
    .then(function(r){if(!r.ok)throw new Error('http '+r.status);return r.json();})
    .then(function(data){
      var items=(data&&data.items)||[];
      if(!items.length){showInsightsFallback();return;}
      grid.innerHTML=items.map(renderInsightCard).join('');
      grid.style.display='grid';
      if(status)status.style.display='none';
    })
    .catch(function(){_insightsLoaded=false;showInsightsFallback();});
}

/* ---- Demo request modal ---- */
function openModal(){demoError('');document.getElementById('demoModal').classList.add('open');document.body.style.overflow='hidden';}
function closeModal(){document.getElementById('demoModal').classList.remove('open');document.body.style.overflow='';}
function closeModalOutside(e){if(e.target===document.getElementById('demoModal'))closeModal();}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
function showDemoSuccess(){
  document.getElementById('modalForm').style.display='none';
  document.getElementById('formSuccess').style.display='block';
  // Paid-acquisition conversion signal. GTM maps the `demo_request` event to the
  // LinkedIn Insight + Google Ads conversion tags (tags only load when the IDs in
  // marketing/build.mjs TRACKING are set; this push is a harmless no-op otherwise).
  window.dataLayer=window.dataLayer||[];
  window.dataLayer.push({event:'demo_request'});
  // LinkedIn Insight Tag event-specific conversion (conversion_id injected by build.mjs TRACKING).
  if(window.lintrk&&window._capiroLiConversionId){window.lintrk('track',{conversion_id:window._capiroLiConversionId});}
}
/* Validation feedback: the home modal has an inline #formError panel; the other
   pages' modal does not, so fall back to alert() there. */
function demoError(msg){
  const box=document.getElementById('formError');
  if(box){box.textContent=msg||'';box.style.display=msg?'block':'none';}
  else if(msg){alert(msg);}
}
function submitDemo(){
  const first=document.getElementById('firstName').value.trim();
  const last=document.getElementById('lastName').value.trim();
  const email=document.getElementById('workEmail').value.trim();
  const firm=document.getElementById('firmName').value.trim();
  const role=document.getElementById('role').value;
  const practice=document.getElementById('practiceType').value;
  if(!first||!last||!email||!firm||!role||!practice){demoError('Please fill in all required fields.');return;}
  const emailReg=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!emailReg.test(email)){demoError('Please enter a valid email address.');return;}
  const personal=['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','protonmail.com','me.com'];
  if(personal.includes(email.split('@')[1].toLowerCase())){demoError('Please use your work or firm email address.');return;}
  demoError('');
  // Optional qualifier — present in the other pages' modal, absent from the home one.
  const clients=document.getElementById('clientCount');
  const btn=document.querySelector('.form-submit');btn.textContent='Sending...';btn.disabled=true;
  fetch('https://api.hsforms.com/submissions/v3/integration/submit/245730593/e00a7515-d4f6-4d23-8316-db797671d872',
    {method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({fields:[{name:'firstname',value:first},{name:'lastname',value:last},{name:'email',value:email},{name:'company',value:firm},{name:'jobtitle',value:role},{name:'practice_type',value:practice},{name:'active_client_count',value:(clients&&clients.value)||''}],context:{pageUri:window.location.href,pageName:document.title}})})
  .then(showDemoSuccess)
  .catch(showDemoSuccess);
}

document.addEventListener('DOMContentLoaded',function(){loadInsights();});
