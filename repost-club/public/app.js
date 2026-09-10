const $ = (s, root=document) => root.querySelector(s);
const $$ = (s, root=document) => [...root.querySelectorAll(s)];
let token = localStorage.getItem('rr_token') || '';
let me = null;

function toast(message){
  const el=$('#toast'); el.textContent=message; el.classList.add('show');
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove('show'),2600);
}

async function api(path, options={}){
  const headers={...(options.headers||{})};
  if(options.body && typeof options.body !== 'string'){
    headers['content-type']='application/json'; options.body=JSON.stringify(options.body);
  }
  if(token) headers.authorization=`Bearer ${token}`;
  const res=await fetch(path,{...options,headers});
  let data={}; try{data=await res.json()}catch{}
  if(!res.ok) throw new Error(data.error||'Error inesperado');
  return data;
}

function setAuth(logged){
  $('#authView').classList.toggle('hidden',logged);
  $('#appView').classList.toggle('hidden',!logged);
}

function escapeHtml(v=''){
  return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#039;','"':'&quot;'}[c]));
}

function initials(v='U'){return v.slice(0,2).toUpperCase()}
function actionLabel(t){return {like:'❤️ Like',comment:'💬 Comentario',repost:'🔁 Repost',mention:'🏷️ Mención'}[t]||t}
function actionText(t){return {like:'dio like',comment:'comentó',repost:'reposteó',mention:'mencionó'}[t]||'colaboró'}
function timeLeft(date){
  const ms=new Date(date.endsWith('Z')?date:date+'Z')-Date.now();
  if(ms<=0)return 'Vencida';
  const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000); return `${h}h ${m}m`;
}
function timeAgo(date){
  const ms=Date.now()-new Date(String(date).replace(' ','T')+'Z').getTime();
  const m=Math.max(0,Math.floor(ms/60000));
  if(m<1)return 'ahora';
  if(m<60)return `hace ${m} min`;
  const h=Math.floor(m/60); if(h<24)return `hace ${h} h`;
  return `hace ${Math.floor(h/24)} d`;
}

function instagramEmbedUrl(raw){
  try{
    const u=new URL(String(raw||'').trim());
    if(!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    const parts=u.pathname.split('/').filter(Boolean);
    let type=parts[0];
    if(type==='reels') type='reel';
    if(!['p','reel','tv'].includes(type)||!parts[1]) return null;
    return `https://www.instagram.com/${type}/${encodeURIComponent(parts[1])}/embed/`;
  }catch{return null}
}

let previewTimer=null;
function updatePostPreview(raw){
  const box=$('#postPreview');
  if(!box)return;
  const embed=instagramEmbedUrl(raw);
  if(!embed){box.classList.remove('show');box.innerHTML='';return;}
  box.classList.add('show');
  box.innerHTML=`<div class="preview-head"><div><span>VISTA PREVIA</span><strong>Publicación de Instagram</strong></div><a href="${escapeHtml(String(raw).trim())}" target="_blank" rel="noopener noreferrer">Abrir ↗</a></div><div class="preview-frame-wrap"><iframe class="instagram-frame" src="${embed}" loading="lazy" allowtransparency="true" frameborder="0" scrolling="no"></iframe></div><p class="preview-note">La vista previa funciona con publicaciones públicas. Si Instagram la bloquea por privacidad, el enlace igualmente se puede publicar.</p>`;
}

async function refreshMe(){
  const data=await api('/api/me'); me=data.user;
  $('#topUser').textContent=me.username;
  $('#topIg').textContent=me.instagram_username?`@${me.instagram_username}`:'Instagram sin vincular';
  $('#topPoints').textContent=me.points;
  $('#profilePoints').textContent=me.points;
  $('#trustScore').textContent=me.trust_score;
  $('#transactions').innerHTML=data.transactions.length?data.transactions.map(t=>`<div class="transaction"><div><strong>${escapeHtml(t.note||t.type)}</strong><br><small>${escapeHtml(t.created_at)}</small></div><strong class="${t.amount>=0?'plus':'minus'}">${t.amount>=0?'+':''}${t.amount} PT</strong></div>`).join(''):'<div class="empty">Todavía no hay movimientos.</div>';
}

async function refreshFeed(){
  const {posts}=await api('/api/feed');
  $('#feed').innerHTML=posts.length?posts.map(renderPost).join(''):'<div class="empty">No hay campañas activas ahora.</div>';
}

async function refreshCommunity(){
  const data=await api('/api/community');
  const online=data.online||[];
  const activity=data.activity||[];

  $('#onlineCount').textContent=online.length;
  $('#onlineUsers').innerHTML=online.length?online.map(u=>`<div class="online-user">
    <div class="presence-avatar">${initials(u.username)}<span class="presence-dot"></span></div>
    <div><strong>${escapeHtml(u.username)}${u.id===me?.id?' <span class="you">vos</span>':''}</strong><span>${u.instagram_username?'@'+escapeHtml(u.instagram_username):'En línea'}</span></div>
  </div>`).join(''):'<div class="side-empty">Nadie conectado ahora.</div>';

  $('#communityActivity').innerHTML=activity.length?activity.map(a=>{
    if(a.type==='post') return `<div class="activity-item"><span class="activity-icon">＋</span><div><strong>${escapeHtml(a.actor)}</strong> agregó <b>${escapeHtml(a.detail)}</b><span>${timeAgo(a.created_at)}</span></div></div>`;
    return `<div class="activity-item"><span class="activity-icon">${a.detail==='like'?'♥':a.detail==='repost'?'↻':a.detail==='mention'?'@':'●'}</span><div><strong>${escapeHtml(a.actor)}</strong> ${actionText(a.detail)} a <b>${escapeHtml(a.target||'otro usuario')}</b><span>${timeAgo(a.created_at)}</span></div></div>`;
  }).join(''):'<div class="side-empty">Todavía no hay actividad.</div>';
}

function renderPost(p){
  const own=Number(p.user_id)===Number(me?.id);
  const actions=p.actions.map(a=>{
    const full=a.completed>=a.target;
    const auto=a.verification==='automatic';
    const disabled=own||a.already_done||full;
    return `<button class="action-btn" data-action-id="${a.id}" data-url="${escapeHtml(p.url)}" data-auto="${auto}" ${disabled?'disabled':''}>
      <span>${actionLabel(a.type)}<br><small>${a.completed}/${a.target} · <span class="badge ${auto?'auto':'trust'}">${auto?'AUTO':'CONFIANZA'}</span></small></span>
      <b>${own?'—':`+${a.reward} PT`}</b>
    </button>`;
  }).join('');
  return `<article class="post-card ${own?'own-post':''}">
    <div class="post-top"><div class="author"><div class="avatar">${initials(p.username)}</div><div class="author-meta"><strong>${escapeHtml(p.username)} ${own?'<span class="own-badge">TU CAMPAÑA</span>':''}</strong><span>${p.instagram_username?'@'+escapeHtml(p.instagram_username):'Instagram'}</span></div></div><div class="timer">${timeLeft(p.expires_at)}</div></div>
    <h3 class="post-title">${escapeHtml(p.title||'Nueva publicación')}</h3>
    <a class="post-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(p.url)}</a>
    <div class="actions">${actions}</div>
  </article>`;
}

async function refreshMyPosts(){
  const {posts}=await api('/api/my-posts');
  $('#myPosts').innerHTML=posts.length?posts.map(p=>`<article class="post-card"><div class="post-top"><div><strong>${escapeHtml(p.title||'Publicación')}</strong><div class="muted">${escapeHtml(p.platform)} · ${escapeHtml(p.status)}</div></div><div class="timer">${timeLeft(p.expires_at)}</div></div><div class="cost"><span>Usados / reservados</span><strong>${p.spent} / ${p.budget} PT</strong></div><div class="progress"><span style="width:${Math.min(100,Number(p.budget)?Number(p.spent)/Number(p.budget)*100:0)}%"></span></div></article>`).join(''):'<div class="empty">Todavía no publicaste campañas.</div>';
}

async function enterApp(){
  try{
    setAuth(true); await refreshMe(); await Promise.all([refreshFeed(),refreshMyPosts(),refreshCommunity()]);
  }catch(e){
    token=''; localStorage.removeItem('rr_token'); setAuth(false);
  }
}

$$('[data-auth-tab]').forEach(btn=>btn.addEventListener('click',()=>{
  $$('[data-auth-tab]').forEach(x=>x.classList.toggle('active',x===btn));
  $('#loginForm').classList.toggle('active',btn.dataset.authTab==='login');
  $('#registerForm').classList.toggle('active',btn.dataset.authTab==='register');
}));

$('#loginForm').addEventListener('submit',async e=>{
  e.preventDefault(); const f=new FormData(e.currentTarget);
  try{const data=await api('/api/login',{method:'POST',body:Object.fromEntries(f)}); token=data.token;localStorage.setItem('rr_token',token);toast('Sesión iniciada');await enterApp()}catch(err){toast(err.message)}
});

$('#registerForm').addEventListener('submit',async e=>{
  e.preventDefault(); const f=new FormData(e.currentTarget);
  try{const data=await api('/api/register',{method:'POST',body:Object.fromEntries(f)});token=data.token;localStorage.setItem('rr_token',token);toast('Cuenta creada · +50 PT');await enterApp()}catch(err){toast(err.message)}
});

function showView(name){
  $$('.view').forEach(v=>v.classList.toggle('active',v.id===`${name}View`));
  $$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
  if(name==='feed') refreshFeed().catch(e=>toast(e.message));
  if(name==='activity') refreshMyPosts().catch(e=>toast(e.message));
  if(name==='profile') refreshMe().catch(e=>toast(e.message));
}
$$('[data-view]').forEach(b=>b.addEventListener('click',()=>showView(b.dataset.view)));

function updateCost(){
  const prices={like:1,comment:2,repost:3,mention:3}; let total=0;
  $$('#publishForm input[name="action"]:checked').forEach(ch=>{
    total+=prices[ch.value]*Number($(`#publishForm input[name="${ch.value}_target"]`).value||1);
  });
  $('#costValue').textContent=total;
}
$('#publishForm').addEventListener('input',updateCost);

const publishUrl=$('#publishUrl');
if(publishUrl){
  publishUrl.addEventListener('input',()=>{
    clearTimeout(previewTimer);
    previewTimer=setTimeout(()=>updatePostPreview(publishUrl.value),350);
  });
  publishUrl.addEventListener('paste',()=>{
    clearTimeout(previewTimer);
    previewTimer=setTimeout(()=>updatePostPreview(publishUrl.value),80);
  });
}

$('#publishForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.currentTarget;
  const f=new FormData(form);
  const actions=[];
  $$('input[name="action"]:checked',form).forEach(ch=>actions.push({type:ch.value,target:Number(f.get(`${ch.value}_target`))}));
  try{
    const data=await api('/api/posts',{method:'POST',body:{url:f.get('url'),title:f.get('title'),platform:f.get('platform'),actions}});
    toast(`Campaña publicada · ${data.cost} PT reservados`);
    form.reset();
    $$('input[type="number"]',form).forEach(i=>i.value=4);
    updateCost(); updatePostPreview('');
    await Promise.all([refreshMe(),refreshFeed(),refreshMyPosts(),refreshCommunity()]);
    showView('feed');
  }catch(err){toast(err.message)}
});

$('#feed').addEventListener('click',async e=>{
  const btn=e.target.closest('[data-action-id]'); if(!btn||btn.disabled)return;
  window.open(btn.dataset.url,'_blank','noopener,noreferrer');
  if(btn.dataset.auto==='true'){
    toast('Abrí la publicación. Esta acción se acreditará cuando Instagram la verifique.');return;
  }
  const ok=confirm('Se abrió la publicación. Marcá Aceptar solo después de completar realmente la acción.');
  if(!ok)return;
  try{const d=await api(`/api/actions/${btn.dataset.actionId}/complete`,{method:'POST'});toast(`Acción registrada · +${d.reward} PT`);await Promise.all([refreshMe(),refreshFeed(),refreshCommunity()])}catch(err){toast(err.message)}
});

$('#refreshBtn').addEventListener('click',()=>Promise.all([refreshMe(),refreshFeed(),refreshCommunity()]).catch(e=>toast(e.message)));
$('#logoutBtn').addEventListener('click',async()=>{
  try{await api('/api/logout',{method:'POST'})}catch{}
  token='';me=null;localStorage.removeItem('rr_token');setAuth(false);toast('Sesión cerrada');
});

updateCost();
if(token) enterApp(); else setAuth(false);
setInterval(()=>{if(token) Promise.all([refreshFeed(),refreshCommunity()]).catch(()=>{})},30000);
