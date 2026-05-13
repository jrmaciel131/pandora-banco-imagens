/* Login, sessão, seleção e troca de base ativa. */

let currentBase = null;
let availableBases = [];
let pendingActivation = null;
let sessionExpires = 0, sessionWarnAt = 0, sessionWarnShown = false;
let userRole = 'user';

async function doLogin(){
  const u = document.getElementById('lu').value.trim();
  const p = document.getElementById('lp').value;
  const btn = document.getElementById('lb2'), err = document.getElementById('le');
  btn.innerHTML = '<span class="spin"></span> Entrando...';
  btn.disabled = true;
  err.style.display = 'none';
  try{
    const r = await api('login', {user:u, pass:p}, 'POST');
    if(r.ok){
      if(r.last_base) await selectBase(r.last_base, r);
      else showBaseSelector(r);
    } else {
      err.textContent = r.error || 'Usuário ou senha não encontrados.';
      err.style.display = 'block';
    }
  } catch(e){
    err.textContent = 'Erro de conexão com o servidor. Tente novamente.';
    err.style.display = 'block';
  }
  btn.innerHTML = 'Entrar';
  btn.disabled = false;
}

async function doLogout(){ await api('logout', {}, 'POST'); location.reload(); }

document.getElementById('lp').addEventListener('keydown', e => {
  if(e.key === 'Enter') doLogin();
});

function showBaseSelector(loginData){
  const bases = loginData.bases || [];
  if(bases.length === 1){ selectBase(bases[0].key, loginData); return; }

  document.getElementById('ls').style.display = 'none';
  const loader = document.getElementById('session-loading');
  if(loader) loader.style.display = 'none';
  const bs = document.getElementById('bs');
  bs.style.display = 'flex';
  const userEl = document.getElementById('bs-user');
  if(userEl) userEl.textContent = `Logado como: ${loginData.user}`;
  const container = document.getElementById('base-buttons');
  container.innerHTML = '';
  bases.forEach(b => {
    const btn = document.createElement('button');
    btn.className = 'btn bp';
    btn.style.cssText = 'padding:14px 20px;font-size:16px;justify-content:center;border-radius:var(--r)';
    const tag = b.is_test ? '<span style="font-size:10px;font-weight:700;background:#f59e0b;color:#fff;padding:2px 7px;border-radius:10px;margin-left:8px">TESTE</span>' : '';
    btn.innerHTML = `${b.emoji} ${b.label} ${tag}`;
    btn.onclick = () => selectBase(b.key, loginData);
    container.appendChild(btn);
  });
}

async function selectBase(baseKey, loginData){
  const loader = document.getElementById('session-loading');
  const loaderMsg = loader ? loader.querySelector('div:last-child') : null;
  if(loaderMsg) loaderMsg.textContent = 'Carregando base...';
  if(loader) loader.style.display = 'flex';
  document.getElementById('bs').style.display = 'none';

  try{
    const r = await api('switch_base', {base:baseKey}, 'POST');
    if(!r.ok){ showToast('Erro ao selecionar base: '+(r.error||'')); return; }
    currentBase = baseKey;
    casos = []; filtered = [];
    thumbCache = {};
    _baseGeneration++;
    _pageGeneration++;
    if(loginData.bases) availableBases = loginData.bases;

    if(r.casos){
      activateApp({...loginData, base:r.base, base_label:r.label, base_emoji:r.emoji, _casos:r.casos, _profs:r.profissionais||[]});
    } else {
      activateApp({...loginData, base:r.base, base_label:r.label, base_emoji:r.emoji});
    }
  } finally {
    if(loader) loader.style.display = 'none';
  }
}

async function switchBase(baseKey){
  if(baseKey === currentBase){ closeMoreMenu(); return; }
  closeMoreMenu();

  const loader = document.getElementById('session-loading');
  const loaderMsg = loader ? loader.querySelector('div:last-child') : null;
  if(loaderMsg) loaderMsg.textContent = 'Trocando de base...';
  if(loader) loader.style.display = 'flex';

  try{
    const r = await api('switch_base', {base:baseKey}, 'POST');
    if(!r.ok){ showToast('Erro: '+(r.error||'')); return; }
    currentBase = baseKey;

    _baseGeneration++;
    _pageGeneration++;
    thumbCache = {};
    casos = []; filtered = [];
    selUF = ''; selCity = ''; selProf = ''; ibgeCities = [];
    selMode = false; selIds = new Set(); bulkSelIds = new Set();
    _highPriorityIds = new Set();
    currentCaso = null;
    document.getElementById('ov').classList.remove('open');
    ['fuf','fci','fpro','fids'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    _userTouchedShow = false;
    const fshow = document.getElementById('fshow'); if(fshow) fshow.value = 'disponivel';
    const cw = document.getElementById('cw'); if(cw) cw.style.display = 'none';
    mode = 'estado';
    const te = document.getElementById('te'); if(te) te.classList.add('active');
    const tc = document.getElementById('tc'); if(tc) tc.classList.remove('active');

    const grid = document.getElementById('grid');
    if(grid) grid.innerHTML = '';
    const empty = document.getElementById('empty');
    if(empty) empty.style.display = 'none';
    page = 1;

    updateBaseBadge(r.base, r.label, r.emoji);
    updateBaseMenu(r.base);

    /* Backend devolve os casos na própria resposta do switch_base — elimina
       race condition onde loadCasos() chegava antes da sessão persistir. */
    if(r.casos){
      casos = r.casos; allProfs = r.profissionais || []; applyFilter();
    } else {
      await loadCasos();
    }

    showToast(`Base ${r.emoji} ${r.label} ativada!`);
  } finally {
    if(loader) loader.style.display = 'none';
  }
}

function updateBaseBadge(base, label, emoji){
  const badge = document.getElementById('tb-base-badge');
  if(badge){ badge.textContent = `${emoji} ${label}`; badge.style.display = 'inline'; }
  const isTest = (base === 'TESTE') || !!(availableBases.find(b => b.key === base) || {}).is_test;
  let banner = document.getElementById('test-mode-banner');
  if(isTest){
    if(!banner){
      banner = document.createElement('div');
      banner.id = 'test-mode-banner';
      banner.style.cssText = 'background:#f59e0b;color:#000;padding:6px 14px;font-size:12px;font-weight:600;text-align:center;display:flex;align-items:center;justify-content:center;gap:10px;flex-wrap:wrap';
      banner.innerHTML = '🧪 <b>MODO TESTE</b> — você está em uma base sandbox para aprender o sistema. As alterações não afetam a operação real. <button onclick="openHelp()" style="background:#000;color:#fff;border:0;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:600;cursor:pointer">📚 Ver tutorial</button>';
      const tb = document.querySelector('#as .topbar');
      if(tb && tb.parentNode) tb.parentNode.insertBefore(banner, tb.nextSibling);
    }
    banner.style.display = 'flex';
  } else if(banner){ banner.style.display = 'none'; }
}

function updateBaseMenu(activeBase){
  const container = document.getElementById('base-menu-items');
  if(!container || !availableBases.length) return;
  container.innerHTML = availableBases.map(b => {
    const tag = b.is_test ? ' <span style="font-size:9px;background:#f59e0b;color:#fff;padding:1px 6px;border-radius:8px;font-weight:700">TESTE</span>' : '';
    return `<div class="tb-drop-item" onclick="switchBase('${b.key}')" style="${b.key === activeBase ? 'font-weight:700;color:var(--accent)' : ''}">
      ${b.emoji} ${b.label}${tag} ${b.key === activeBase ? '✓' : ''}
    </div>`;
  }).join('');
}

function activateApp(r){
  userRole = r.role || 'user';
  currentBase = r.base || currentBase;
  document.getElementById('ls').style.display = 'none';
  const bsEl = document.getElementById('bs'); if(bsEl) bsEl.style.display = 'none';
  const loader = document.getElementById('session-loading');
  if(loader) loader.style.display = 'none';
  const a = document.getElementById('as');
  a.style.display = 'flex';
  a.style.flexDirection = 'column';
  document.getElementById('tu').textContent = r.user + (userRole === 'admin' ? ' 👑' : '');
  sessionExpires = r.expires;
  sessionWarnAt = r.warn_at;
  sessionWarnShown = false;
  document.querySelectorAll('[data-admin]').forEach(el => { el.style.display = userRole === 'admin' ? '' : 'none'; });
  if(r.base_emoji && r.base_label) updateBaseBadge(r.base, r.base_label, r.base_emoji);
  else if(r.base_emoji) updateBaseBadge(r.base, r.label || r.base, r.base_emoji);
  if(r.bases){ availableBases = r.bases; updateBaseMenu(r.base); }
  else if(availableBases.length) updateBaseMenu(r.base || currentBase);
  startSessionTimer();
  initApp(r._casos || null, r._profs || null);
  updateThemeButtons();
  if(userRole === 'admin'){
    initFAB();
    const fab = document.getElementById('metrics-fab');
    if(fab) fab.style.display = 'none';
  }
  try {
    const isTest = (r.base === 'TESTE') || !!(availableBases.find(b => b.key === r.base) || {}).is_test;
    const seen = localStorage.getItem('bi_tour_seen');
    if(isTest && !seen){ setTimeout(() => startTour(true), 600); }
  } catch(e){}
}

function startSessionTimer(){
  clearInterval(window._st);
  window._st = setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    if(now >= sessionExpires){
      clearInterval(window._st);
      alert('Sessão expirada. Faça login novamente.');
      location.reload();
      return;
    }
    if(!sessionWarnShown && now >= sessionWarnAt){
      sessionWarnShown = true;
      document.getElementById('swmin').textContent = Math.ceil((sessionExpires - now) / 60);
      document.getElementById('swarn').style.display = 'flex';
    }
  }, 15000);
}

async function renewSession(){
  const r = await api('renew_session', {}, 'POST');
  if(r.ok){
    sessionExpires = r.expires;
    sessionWarnAt = r.warn_at;
    sessionWarnShown = false;
    document.getElementById('swarn').style.display = 'none';
    showToast('Sessão renovada!');
  }
}

/* Restaura sessão no F5 sem flash de tela de login. */
async function checkSessionOnLoad(){
  const loader = document.getElementById('session-loading');
  try{
    const resp = await fetch('api/handler.php?action=check_session', {credentials:'same-origin'});
    const r = await resp.json().catch(() => ({ok:false, authenticated:false}));
    if(r.ok && r.authenticated){
      if(loader) loader.style.display = 'none';
      if(r.base){
        try {
          const rb = await api('get_bases');
          if(rb.ok) availableBases = rb.bases;
        } catch(e){}
        activateApp(r);
      } else {
        try {
          const rb = await api('get_bases');
          if(rb.ok){
            showBaseSelector({
              user: r.user, role: r.role,
              bases: rb.bases, last_base: null,
              expires: r.expires, warn_at: r.warn_at
            });
          }
        } catch(e){ activateApp(r); }
      }
    } else {
      if(loader) loader.style.display = 'none';
      document.getElementById('ls').style.display = 'flex';
    }
  } catch(e){
    if(loader) loader.style.display = 'none';
    document.getElementById('ls').style.display = 'flex';
  }
}

function toggleMoreMenu(){ document.getElementById('tb-dropdown').classList.toggle('open'); }
function closeMoreMenu(){ document.getElementById('tb-dropdown').classList.remove('open'); }
document.addEventListener('click', e => { if(!e.target.closest('#tb-more')) closeMoreMenu(); });
