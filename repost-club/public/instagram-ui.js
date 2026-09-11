const igStatusText = document.getElementById('instagramStatusText');
const igStatusMeta = document.getElementById('instagramStatusMeta');
const igConnectBtn = document.getElementById('instagramConnectBtn');
const igDisconnectBtn = document.getElementById('instagramDisconnectBtn');

async function refreshInstagramStatus(){
  if(!localStorage.getItem('rr_token')) return;
  try{
    const data = await api('/api/instagram/status');
    if(data.connected && data.connection){
      igStatusText.textContent = `@${data.connection.username}`;
      igStatusMeta.textContent = `Instagram conectado · ${data.connection.account_type || 'Profesional'}`;
      igConnectBtn.textContent = 'RECONECTAR INSTAGRAM';
      igDisconnectBtn.classList.remove('hidden');
    }else{
      igStatusText.textContent = 'Sin conectar';
      igStatusMeta.textContent = 'Conectá tu cuenta profesional para verificar acciones.';
      igConnectBtn.textContent = 'CONECTAR INSTAGRAM';
      igDisconnectBtn.classList.add('hidden');
    }
  }catch(err){
    igStatusText.textContent = 'Configuración pendiente';
    igStatusMeta.textContent = err.message;
  }
}

igConnectBtn?.addEventListener('click', async ()=>{
  try{
    igConnectBtn.disabled = true;
    const data = await api('/api/instagram/oauth/start',{method:'POST'});
    location.href = data.url;
  }catch(err){
    toast(err.message);
    igConnectBtn.disabled = false;
  }
});

igDisconnectBtn?.addEventListener('click', async ()=>{
  if(!confirm('¿Desconectar esta cuenta de Instagram?')) return;
  try{
    await api('/api/instagram/disconnect',{method:'POST'});
    toast('Instagram desconectado');
    await refreshInstagramStatus();
  }catch(err){toast(err.message)}
});

document.addEventListener('click', e=>{
  const btn=e.target.closest('[data-view="profile"]');
  if(btn) setTimeout(refreshInstagramStatus,50);
});

window.addEventListener('load', ()=>{
  const params = new URLSearchParams(location.search);
  if(params.get('instagram')==='connected'){
    toast('Instagram conectado correctamente');
    history.replaceState({},'',location.pathname);
  }else if(params.get('instagram')==='error'){
    toast('No se pudo conectar Instagram');
    history.replaceState({},'',location.pathname);
  }
  setTimeout(refreshInstagramStatus,700);
});
