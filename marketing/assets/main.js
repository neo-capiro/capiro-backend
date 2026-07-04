/* Capiro marketing site — shared behavior.
   Loaded on every page via <script src="/assets/main.js">.
   Navigation is now real <a href> links (no client-side router / showPage).
   Page-specific behavior (e.g. the Solutions industry tabs + pathway map)
   lives inline in that page's template. */

function toggleNav(){var l=document.getElementById('navLinks'),b=document.getElementById('navBurger');if(!l)return;var open=l.classList.toggle('open');if(b){b.classList.toggle('open',open);b.setAttribute('aria-expanded',open?'true':'false');}}
function closeNav(){var l=document.getElementById('navLinks'),b=document.getElementById('navBurger');if(l)l.classList.remove('open');if(b){b.classList.remove('open');b.setAttribute('aria-expanded','false');}}

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
function openModal(){document.getElementById('demoModal').classList.add('open');document.body.style.overflow='hidden';}
function closeModal(){document.getElementById('demoModal').classList.remove('open');document.body.style.overflow='';}
function closeModalOutside(e){if(e.target===document.getElementById('demoModal'))closeModal();}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeModal();});
function submitDemo(){
  const first=document.getElementById('firstName').value.trim();
  const last=document.getElementById('lastName').value.trim();
  const email=document.getElementById('workEmail').value.trim();
  const firm=document.getElementById('firmName').value.trim();
  const role=document.getElementById('role').value;
  const practice=document.getElementById('practiceType').value;
  if(!first||!last||!email||!firm||!role||!practice){alert('Please fill in all required fields.');return;}
  const emailReg=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if(!emailReg.test(email)){alert('Please enter a valid email address.');return;}
  const personal=['gmail.com','yahoo.com','hotmail.com','outlook.com','icloud.com','aol.com','protonmail.com','me.com'];
  if(personal.includes(email.split('@')[1].toLowerCase())){alert('Please use your work or firm email address.');return;}
  const btn=document.querySelector('.form-submit');btn.textContent='Sending...';btn.disabled=true;
  fetch('https://api.hsforms.com/submissions/v3/integration/submit/245730593/e00a7515-d4f6-4d23-8316-db797671d872',
    {method:'POST',headers:{'Content-Type':'application/json'},
     body:JSON.stringify({fields:[{name:'firstname',value:first},{name:'lastname',value:last},{name:'email',value:email},{name:'company',value:firm},{name:'jobtitle',value:role},{name:'practice_type',value:practice},{name:'active_client_count',value:document.getElementById('clientCount').value||''}],context:{pageUri:window.location.href,pageName:document.title}})})
  .then(()=>{document.getElementById('modalForm').style.display='none';document.getElementById('formSuccess').style.display='block';})
  .catch(()=>{document.getElementById('modalForm').style.display='none';document.getElementById('formSuccess').style.display='block';});
}

document.addEventListener('DOMContentLoaded',function(){loadInsights();});
