/* Admin: gestão de usuários, diagnóstico, métricas, histórico e reversões. */

/* Build deste arquivo. Atualize a cada deploy do admin.js; aparece no painel
   "Diagnóstico de versão" do Admin Mode e é comparado com a cópia do servidor
   para revelar quando o navegador está com uma versão em cache. */
const ADMIN_BUILD = 'v23.19 (2026-08-28)';

/* Teto de casos por limpeza de cache em lote. Espelha CLEAR_CACHE_MAX_IDS
   do handler.php: serve só para avisar antes de gastar a requisição. */
const CACHE_IDS_MAX = 100;

let adminModeVisible = false;
let thumbSourceMode = 'auto';
let _checkedUsers = new Set();

function showView(n){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-'+n).classList.add('active');
  if(n === 'hist')  loadHistorico();
  if(n === 'admin') loadAdminPanel();
}

function toggleGodModeVisual(){
  adminModeVisible = !adminModeVisible;
  const btn = document.getElementById('adminmode-toggle');
  if(btn) btn.textContent = adminModeVisible ? '👁 Desativar métricas visuais' : '👁 Ativar métricas visuais';
  const timer = document.getElementById('page-load-timer');
  if(timer) timer.style.display = adminModeVisible ? 'flex' : 'none';

  const fab = document.getElementById('metrics-fab');
  if(fab) fab.style.display = adminModeVisible ? 'flex' : 'none';

  const fabBtn = document.getElementById('fab-metrics-btn');
  if(fabBtn) fabBtn.textContent = `👁 Métricas visuais: ${adminModeVisible?'ON':'OFF'}`;

  let srcBar = document.getElementById('adminmode-srcbar');
  if(adminModeVisible && !srcBar){
    srcBar = document.createElement('div');
    srcBar.id = 'adminmode-srcbar';
    srcBar.style.cssText = 'position:fixed;bottom:5.5rem;right:1.5rem;background:var(--sf);border:1px solid var(--bds);border-radius:var(--r);padding:8px 10px;display:flex;flex-direction:column;gap:6px;z-index:399;box-shadow:var(--shadow-md);font-size:12px;min-width:150px';
    srcBar.innerHTML = `<div style="font-size:10px;color:var(--tx3);font-weight:700;text-transform:uppercase">Origem das imagens</div>
      <button onclick="setThumbSource('auto')"  id="src-auto"  class="btn bs" style="padding:4px 10px;font-size:11px;justify-content:flex-start">🔄 Auto</button>
      <button onclick="setThumbSource('cache')" id="src-cache" class="btn bs" style="padding:4px 10px;font-size:11px;justify-content:flex-start">💾 Cache local</button>
      <button onclick="setThumbSource('drive')" id="src-drive" class="btn bs" style="padding:4px 10px;font-size:11px;justify-content:flex-start">☁️ Google Drive</button>`;
    document.body.appendChild(srcBar);
    setThumbSourceHighlight(thumbSourceMode);
  } else if(!adminModeVisible && srcBar){
    srcBar.remove();
  }

  if(adminModeVisible){
    document.querySelectorAll('[id^="card-"]').forEach(card => {
      const id = card.id.replace('card-','');
      const tc = thumbCache[id];
      if(tc && tc.src) showThumbMeta(id, tc.ms || 0, tc.src);
    });
  } else {
    document.querySelectorAll('.thumb-meta').forEach(el => el.remove());
  }
}

function setThumbSource(src){
  thumbSourceMode = src;
  setThumbSourceHighlight(src);
  thumbCache = {};
  renderGrid();
  showToast(`Origem: ${src==='auto'?'automático':src==='cache'?'cache local':'Google Drive'}`);
  const menu = document.getElementById('fab-menu');
  if(menu) menu.style.display = 'none';
}

function setThumbSourceHighlight(src){
  ['auto','cache','drive'].forEach(s => {
    const b = document.getElementById('src-'+s);
    if(b){
      b.style.fontWeight   = s === src ? '700' : '';
      b.style.background   = s === src ? 'var(--accent)' : '';
      b.style.color        = s === src ? '#fff' : '';
      b.style.borderColor  = s === src ? 'var(--accent)' : '';
    }
  });
}

async function loadAdminPanel(){
  _checkedUsers.clear();
  updateUserBulkBar();
  renderAuditDash();
  loadCanonicalTagsPanel();
  loadDistanceConfig();
  loadCoringas();
  loadVersionInfo();
  try{
    const r = await api('list_users');
    if(!r.ok) return;
    const lst = document.getElementById('users-list');
    const sel = document.getElementById('pwd-user');
    sel.innerHTML = '';
    lst.innerHTML = r.users.map(u => {
      const isAdminRow = u.role === 'admin';
      const uid = esc(u.user);
      const prodBadge = isAdminRow
        ? '<span class="badge bok" title="Admins têm acesso a todas as bases por padrão">🌐 todas as bases</span>'
        : (u.prod_access
            ? '<span class="badge bok">✅ Produção</span>'
            : '<span class="badge bused" style="background:#f59e0b22;color:#92400e;border-color:#f59e0b55">🧪 Modo teste</span>');
      const promoteBtn = isAdminRow
        ? ''
        : (u.prod_access
            ? `<button class="btn bs" style="padding:3px 9px;font-size:11px;border-color:#f59e0b;color:#92400e" onclick="setProdAccess('${uid}', false)">Voltar p/ teste</button>`
            : `<button class="btn bp" style="padding:3px 9px;font-size:11px" onclick="setProdAccess('${uid}', true)">Promover p/ produção</button>`);
      const cb = !isAdminRow
        ? `<input type="checkbox" class="s-user-cb" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer;flex-shrink:0" onchange="onUserCheckChange('${uid}',this.checked)">`
        : `<span style="width:15px;display:inline-block;flex-shrink:0"></span>`;
      return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid var(--bd);flex-wrap:wrap">
        ${cb}
        <span style="font-weight:600;min-width:110px">${uid}</span>
        <span class="badge ${isAdminRow?'bused':'bok'}">${isAdminRow?'👑 admin':'usuário'}</span>
        ${prodBadge}
        <span style="font-size:11px;color:var(--tx3);flex:1;min-width:140px">${u.last_login ? ('último login: '+new Date(u.last_login.replace(' ','T')).toLocaleString('pt-BR')) : 'Nunca acessou'}</span>
        <span style="font-size:11px;color:var(--btx)">${u.changes_30d||0} alt. (30d)</span>
        ${promoteBtn}
        ${!isAdminRow ? `<button class="btn-revert" style="border-color:var(--rtx);color:var(--rtx);padding:3px 9px;font-size:11px" onclick="confirmRemoveUser('${uid}')">Remover</button>` : ''}
      </div>`;
    }).join('');
    r.users.filter(u => u.role !== 'admin').forEach(u => sel.appendChild(new Option(u.user, u.user)));
  } catch(e){}
}

/* Painel "Diagnóstico de versão": confronta o que está no servidor (data, hash,
   build) com o que o navegador carregou de fato. Build do servidor diferente do
   carregado = versão em cache; hash diferente do esperado = arquivo antigo. */
async function loadVersionInfo(){
  const el = document.getElementById('version-info');
  if(!el) return;
  el.innerHTML = '<div style="color:var(--tx2);font-size:12px"><span class="spin"></span> Consultando servidor...</div>';
  // O que o navegador carregou nesta sessão:
  const loaded = {
    'assets/utils.js': (typeof APP_BUILD   !== 'undefined') ? APP_BUILD   : '',
    'assets/admin.js': (typeof ADMIN_BUILD !== 'undefined') ? ADMIN_BUILD : '',
  };
  try{
    const r = await api('version_info');
    if(!r.ok){ el.innerHTML = '<span style="color:var(--rtx)">Erro ao consultar versões.</span>'; return; }
    const rows = r.files.map(f => {
      if(!f.exists) return `<tr><td style="font-family:var(--font-mono)">${esc(f.file)}</td><td colspan="3" style="color:var(--rtx)">não encontrado no servidor</td></tr>`;
      let buildCell = f.build ? esc(f.build) : '<span style="color:var(--tx3)">—</span>';
      const browserBuild = loaded[f.file];
      if(browserBuild !== undefined){
        if(f.build && browserBuild === f.build)      buildCell += ' <span style="color:var(--gtx)">✓ navegador igual</span>';
        else if(f.build && browserBuild !== f.build) buildCell += ` <span style="color:var(--rtx)">✗ navegador em cache: ${esc(browserBuild||'antigo')}</span>`;
      }
      return `<tr>
        <td style="font-family:var(--font-mono);padding:3px 8px 3px 0">${esc(f.file)}</td>
        <td style="padding:3px 8px;color:var(--tx2)">${esc(f.mtime)}</td>
        <td style="font-family:var(--font-mono);padding:3px 8px;color:var(--btx)">${esc(f.sha1)}</td>
        <td style="padding:3px 0">${buildCell}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `
      <div style="font-size:12px;color:var(--tx2);margin-bottom:.6rem;line-height:1.6">
        Backend (handler.php): <b>${esc(r.handler_build||'—')}</b><br>
        Carregado no navegador → utils.js: <b>${esc(loaded['assets/utils.js']||'?')}</b> · admin.js: <b>${esc(loaded['assets/admin.js']||'?')}</b>
      </div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px;min-width:520px">
          <thead><tr style="text-align:left;color:var(--tx3);border-bottom:1px solid var(--bd)">
            <th style="padding:0 8px 4px 0">arquivo</th><th style="padding:0 8px 4px">modificado</th><th style="padding:0 8px 4px">hash (servidor)</th><th style="padding:0 0 4px">build</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch(e){ el.innerHTML = '<span style="color:var(--rtx)">Erro de conexão.</span>'; }
}

function setProdAccess(user, allow){
  const title = allow ? 'Promover para produção' : 'Voltar para modo teste';
  const desc  = allow
    ? `Liberar acesso de <b>${esc(user)}</b> às bases de produção (PH e PO)?`
    : `Restringir <b>${esc(user)}</b> ao modo teste? Ele(a) deixará de ver as bases de produção.`;
  showConfirm(title, desc,
    [{label:'Usuário', val:user}, {label:'Acesso', val:allow?'✅ Produção liberada':'🧪 Apenas modo teste'}],
    async () => {
      try{
        const r = await api('set_production_access', {target_user:user, allow: allow?'1':'0'}, 'POST');
        if(r.ok){ showToast(r.msg||'OK'); loadAdminPanel(); }
        else showToast('Erro: '+(r.error||''));
      } catch(e){ showToast('Erro de conexão.'); }
    }
  );
}

async function runSpeedTest(){
  const id = document.getElementById('speed-id').value.trim();
  const res = document.getElementById('speed-result');
  if(!id){ res.style.display = 'block'; res.innerHTML = '<span style="color:var(--rtx)">Digite um ID de caso.</span>'; return; }
  const clean = id.replace(/^CASO-?/i,'').replace(/\D/g,'');
  const casoId = `CASO-${clean}`;
  res.style.display = 'block';
  res.innerHTML = '<span class="spin"></span> Testando...';
  try{
    const r = await api(`speed_test&id=${encodeURIComponent(casoId)}`);
    if(!r.ok){ res.innerHTML = `<span style="color:var(--rtx)">Erro: ${esc(r.error)}</span>`; return; }
    const winner = r.recommendation === 'cache' ? '🏆 Cache local é mais rápido' : '🏆 Drive direto é mais rápido';
    res.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:.75rem">
        <div style="text-align:center;padding:.75rem;background:var(--sf);border-radius:var(--rs);border:1px solid var(--bd)">
          <div style="font-size:22px;font-weight:700;color:var(--btx)">${r.drive_ms}ms</div>
          <div style="font-size:11px;color:var(--tx2);margin-top:3px">Drive direto</div>
        </div>
        <div style="text-align:center;padding:.75rem;background:var(--sf);border-radius:var(--rs);border:1px solid var(--bd)">
          <div style="font-size:22px;font-weight:700;color:var(--gtx)">${r.cache_ms!=null?r.cache_ms+'ms':'N/A'}</div>
          <div style="font-size:11px;color:var(--tx2);margin-top:3px">Cache local</div>
        </div>
      </div>
      <div style="font-weight:600;color:var(--gtx)">${winner}</div>
      <div style="font-size:12px;color:var(--tx2);margin-top:4px">${r.photo_count} foto(s) · thumb local: ${r.has_local_thumb?'✓ sim':'✗ não (rode o cron)'}</div>`;
  } catch(e){ res.innerHTML = `<span style="color:var(--rtx)">Erro: ${e.message}</span>`; }
}

/* Requisitos de senha: mín. 6 chars, maiúscula, minúscula, número e
   caractere especial. Retorna lista de critérios que ainda faltam. */
function validatePassword(pass){
  const errs = [];
  if(pass.length < 6) errs.push('mínimo 6 caracteres');
  if(!/[A-Z]/.test(pass)) errs.push('letra maiúscula');
  if(!/[a-z]/.test(pass)) errs.push('letra minúscula');
  if(!/[0-9]/.test(pass)) errs.push('número');
  if(!/[^A-Za-z0-9]/.test(pass)) errs.push('caractere especial (!@#$...)');
  return errs;
}

function changePassword(){
  const err = document.getElementById('pwd-err');
  try {
    const userEl = document.getElementById('pwd-user');
    const passEl = document.getElementById('pwd-new');
    if(!userEl || !passEl){
      alert('Erro: campo de usuário ou de senha não encontrado na página (pwd-user/pwd-new).');
      return;
    }
    const user = userEl.value;
    const pass = passEl.value;
    if(err) err.textContent = '';
    if(!user){ if(err) err.textContent = 'Selecione um usuário.'; return; }
    const errs = validatePassword(pass);
    if(errs.length){ if(err) err.textContent = 'Senha inválida: falta '+errs.join(', ')+'.'; return; }
    showConfirm(
      'Confirmar alteração de senha',
      `Alterar senha do usuário <b>${esc(user)}</b>?`,
      [{label:'Usuário', val:user}, {label:'Nova senha', val:'••••••'+pass.slice(-2)}],
      async () => {
        try{
          const r = await api('change_password', {target_user:user, new_password:pass}, 'POST');
          if(r.ok){ showToast(r.msg); passEl.value = ''; }
          else if(err) err.textContent = r.error || 'Erro.';
        } catch(e){ if(err) err.textContent = 'Erro de conexão: ' + (e && e.message ? e.message : e); }
      }
    );
  } catch(e){
    // Qualquer falha inesperada antes/ao abrir a confirmação fica visível em um
    // alerta (e no console) em vez de deixar a tela travada no overlay.
    const msg = 'Falha ao abrir a confirmação: ' + (e && e.message ? e.message : e);
    if(err) err.textContent = msg;
    console.error('changePassword:', e);
    alert(msg + (e && e.stack ? '\n\n' + e.stack : ''));
  }
}

/* Diagnóstico isolado do modal de confirmação. Verifica a presença de cada
   elemento, tenta abrir o modal e mede a caixa renderizada, reportando tudo em
   um alerta — útil para depurar em ambientes onde "só aparece o blur". */
function diagnoseConfirmModal(){
  const linhas = [];
  ['confirm-modal','confirm-title','confirm-desc','confirm-changes','confirm-ok-btn'].forEach(id => {
    linhas.push(id + ': ' + (document.getElementById(id) ? 'OK' : 'AUSENTE'));
  });
  linhas.push('showConfirm: ' + (typeof showConfirm === 'function' ? 'OK' : 'AUSENTE'));
  try{
    showConfirm('Teste de diagnóstico',
      'Se você está vendo esta janela, o modal de confirmação funciona.',
      [{label:'Status', val:'OK'}],
      () => { showToast('Confirmação funcionou!'); });
    const box = document.querySelector('#confirm-modal .modal');
    if(box){
      const r = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      linhas.push(`caixa: ${Math.round(r.width)}x${Math.round(r.height)} px · visibility=${cs.visibility} · display=${cs.display} · opacity=${cs.opacity}`);
      linhas.push('overlay aberto: ' + document.getElementById('confirm-modal').classList.contains('open'));
    } else {
      linhas.push('caixa .modal: NÃO ENCONTRADA');
    }
  } catch(e){
    linhas.push('ERRO ao abrir: ' + (e && e.message ? e.message : e));
  }
  alert('🩺 Diagnóstico do modal de confirmação\n\n' + linhas.join('\n'));
}

function confirmRemoveUser(user){
  showConfirm('Remover usuário', `Remover permanentemente o usuário <b>${esc(user)}</b>?`,
    [{label:'Usuário', val:user}, {label:'Atenção', val:'Esta ação não pode ser desfeita'}],
    async () => {
      try{
        const r = await api('remove_user', {target_user:user}, 'POST');
        if(r.ok){ showToast(`Usuário ${user} removido.`); loadAdminPanel(); }
        else showToast('Erro: '+(r.error||''));
      } catch(e){ showToast('Erro de conexão.'); }
    }
  );
}

async function addUser(){
  const user = document.getElementById('new-user').value.trim();
  const pass = document.getElementById('new-pass').value;
  const role = document.getElementById('new-role').value;
  const err = document.getElementById('add-user-err');
  err.textContent = '';
  if(!user || !/^[a-z0-9_]{3,30}$/.test(user)){ err.textContent = 'Nome de usuário inválido (3-30 chars, só letras/números/_.'; return; }
  const errs = validatePassword(pass);
  if(errs.length){ err.textContent = 'Senha inválida: falta '+errs.join(', ')+'.'; return; }
  try{
    const r = await api('add_user', {new_user:user, new_password:pass, role}, 'POST');
    if(r.ok){
      showToast(`Usuário ${user} criado!`);
      document.getElementById('new-user').value = '';
      document.getElementById('new-pass').value = '';
      loadAdminPanel();
    } else err.textContent = r.error || 'Erro.';
  } catch(e){ err.textContent = 'Erro de conexão.'; }
}

/* Histórico agrupado por sessão (mesmo usuário, intervalo < 30min). */
async function loadHistorico(){
  const body = document.getElementById('hist-body');
  body.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--tx2)"><span class="spin"></span></div>';
  const cq = document.getElementById('hfcaso').value.trim();
  const uq = document.getElementById('hfuser').value;
  const sq = document.getElementById('hfsearch')?.value.trim() || '';
  const cid = cq ? `CASO-${cq.replace(/^CASO-?/i,'').replace(/\D/g,'')}` : '';

  try{
    const r = await api(`historico${cid?'&caso_id='+encodeURIComponent(cid):''}${uq?'&usuario='+encodeURIComponent(uq):''}&limit=200`);
    if(!r.ok) throw new Error(r.error || 'Erro');

    const sel = document.getElementById('hfuser');
    const curVal = sel.value;
    const usersInLog = [...new Set(r.log.map(e => e.usuario))].sort();
    sel.innerHTML = '<option value="">Todos os usuários</option>';
    usersInLog.forEach(u => sel.appendChild(new Option(u, u)));
    if(curVal) sel.value = curVal;

    let log = r.log;
    if(sq){
      const sqn = sq.toLowerCase();
      log = log.filter(e => {
        const antes = e.antes, depois = e.depois;
        const searchIn = [
          ...(antes?.ufs||[]), ...(depois?.ufs||[]),
          ...(antes?.cidades||[]), ...(depois?.cidades||[]),
          ...(antes?.clientes||[]), ...(depois?.clientes||[]),
          e.caso_id, e.usuario
        ].join(' ').toLowerCase();
        return searchIn.includes(sqn);
      });
    }

    if(!log.length){ body.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--tx2)">Nenhum registro encontrado.</div>'; return; }

    const SESSION_GAP_MS = 30 * 60 * 1000;
    const groups = [];
    let curGroup = null;
    for(const e of log){
      const ts = new Date(e.criado_em.replace(' ','T')).getTime();
      if(!curGroup || e.usuario !== curGroup.usuario || (curGroup.lastTs - ts) > SESSION_GAP_MS){
        curGroup = {usuario: e.usuario, entries: [], lastTs: ts};
        groups.push(curGroup);
      }
      curGroup.entries.push({...e, ts});
      curGroup.lastTs = Math.min(curGroup.lastTs, ts);
    }

    let html = '';
    groups.forEach((g, gi) => {
      const dt0 = new Date(g.entries[0].criado_em.replace(' ','T')).toLocaleString('pt-BR');
      const dtL = new Date(g.entries[g.entries.length-1].criado_em.replace(' ','T')).toLocaleString('pt-BR');
      const timeRange = g.entries.length > 1 ? `${dtL} → ${dt0}` : dt0;
      const canRevertGroup = g.entries.some(e => e.antes && !isAlreadyReverted(e));

      html += `<div class="hist-group">
        <div class="hist-group-header">
          <div>
            <div class="hist-group-title">👤 ${esc(g.usuario)} — ${g.entries.length} alteração(ões)</div>
            <div class="hist-group-meta">${esc(timeRange)}</div>
          </div>
          ${userRole === 'admin'
            ? `<button class="hist-group-revert" onclick="revertGroup(${gi})" ${canRevertGroup?'':'disabled'} title="${canRevertGroup?'Reverter grupo':'Sem dados suficientes'}">↩ Reverter grupo</button>`
            : `<span style="font-size:11px;color:var(--tx3)">Reversão: contate um admin</span>`
          }
        </div>
        <table class="log-table">
          <thead><tr><th>Hora</th><th>Caso</th><th>Ação</th><th>Alteração</th><th></th></tr></thead>
          <tbody>`;

      g.entries.forEach((e, ei) => {
        const ac = e.acao || '', cls = ac.includes('remove') ? 'la-rm' : ac.includes('bulk') ? 'la-bulk' : 'la-add';
        const dt = new Date(e.criado_em.replace(' ','T')).toLocaleString('pt-BR');
        let diff = '';
        if(e.antes && e.depois){
          const f = a => (a||[]).join(', ') || '—';
          const fc = a => (a||[]).map(cap).join(', ') || '—';
          const has = k => (e.antes && k in e.antes) || (e.depois && k in e.depois);
          const rows = [];
          if(has('ufs'))      rows.push(`<div><span class="diff-antes">${esc(f(e.antes.ufs))}</span> → <span class="diff-depois">${esc(f(e.depois.ufs))}</span></div>`);
          if(has('cidades'))  rows.push(`<div><span class="diff-antes">${esc(fc(e.antes.cidades))}</span> → <span class="diff-depois">${esc(fc(e.depois.cidades))}</span></div>`);
          if(has('clientes')) rows.push(`<div><span class="diff-antes">${esc(f(e.antes.clientes))}</span> → <span class="diff-depois">${esc(f(e.depois.clientes))}</span></div>`);
          if(has('tags'))     rows.push(`<div>tags: <span class="diff-antes">${esc(f(e.antes.tags))}</span> → <span class="diff-depois">${esc(f(e.depois.tags))}</span></div>`);
          if(has('motivo_bloqueio')) rows.push(`<div>motivo: <span class="diff-antes">${esc(e.antes.motivo_bloqueio||'—')}</span> → <span class="diff-depois">${esc(e.depois.motivo_bloqueio||'—')}</span></div>`);
          diff = rows.join('');
        }
        const canRevert = !!e.antes;
        const alreadyReverted = (e.acao || '').includes('revert');
        const revertBtnDisabled = !canRevert || alreadyReverted || userRole !== 'admin';
        const revertTitle = userRole !== 'admin' ? 'Apenas administradores podem reverter. Contate um admin.' : (!canRevert ? 'Sem dados para reverter' : alreadyReverted ? 'Esta entrada já é uma reversão' : 'Reverter esta alteração');
        const revertCls = alreadyReverted ? 'la-revert' : cls;
        html += `<tr>
          <td style="white-space:nowrap;color:var(--tx2);font-size:11px">${esc(dt)}</td>
          <td style="color:var(--btx);font-weight:600">${esc(e.caso_id)}</td>
          <td><span class="la ${revertCls}">${esc(ac.replace('_',' '))}</span>${alreadyReverted?' <span style="font-size:9px;color:var(--tx3)">(revertido)</span>':''}</td>
          <td>${diff}</td>
          <td>${userRole === 'admin'
            ? `<button class="btn-revert" onclick="revertEntry(${gi},${ei})" ${revertBtnDisabled?'disabled':''} title="${revertTitle}" style="${alreadyReverted?'opacity:.35;cursor:not-allowed':''}">↩ Reverter</button>`
            : `<span style="font-size:10px;color:var(--tx3)">só admin</span>`
          }</td>
        </tr>`;
      });
      html += '</tbody></table></div>';
    });

    body.innerHTML = html;
    body._groups = groups;
  } catch(e){
    body.innerHTML = `<div style="padding:2rem;text-align:center;color:var(--rtx)">Erro: ${esc(e.message)}</div>`;
  }
}

/* Exporta o histórico atualmente carregado (já com os filtros aplicados) para
   um arquivo .csv — abre direto no Excel/Sheets. Usa os grupos que loadHistorico
   guardou em hist-body._groups. */
function exportHistoricoGeral(){
  const body = document.getElementById('hist-body');
  const groups = body && body._groups;
  if(!groups || !groups.length){ showToast('Nada para exportar — carregue o histórico primeiro.'); return; }
  const fmt = o => o ? JSON.stringify(o).replace(/[\r\n]+/g,' ') : '';
  const rows = [['Data/Hora','Usuário','Caso','Ação','Antes','Depois']];
  groups.forEach(g => g.entries.forEach(e => {
    const dt = e.criado_em ? new Date(String(e.criado_em).replace(' ','T')).toLocaleString('pt-BR') : '';
    rows.push([dt, e.usuario||'', e.caso_id||'', (e.acao||'').replace(/_/g,' '), fmt(e.antes), fmt(e.depois)]);
  }));
  // CSV com ; (padrão pt-BR no Excel) e BOM pra acentos abrirem corretos.
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g,'""')}"`).join(';')).join('\r\n');
  const blob = new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `historico_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Histórico exportado (.csv).');
}

function histLoading(show, msg = ''){
  const body = document.getElementById('hist-body');
  if(show){
    body._savedContent = body.innerHTML;
    body.innerHTML = `<div style="padding:3rem;text-align:center;color:var(--tx2)">
      <div style="margin-bottom:1rem"><span class="spin" style="width:28px;height:28px;border-width:3px"></span></div>
      <div style="font-size:14px;font-weight:500">${msg||'Aguarde...'}</div>
    </div>`;
  } else if(body._savedContent){
    body.innerHTML = body._savedContent;
  }
}

function histSuccess(title, details){
  const body = document.getElementById('hist-body');
  body.innerHTML = `<div style="padding:2.5rem;text-align:center">
    <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
    <div style="font-size:16px;font-weight:700;color:var(--gtx);margin-bottom:.5rem">${esc(title)}</div>
    <div style="font-size:13px;color:var(--tx2);margin-bottom:1.25rem;white-space:pre-line">${esc(details)}</div>
    <button class="btn bp" onclick="loadHistorico()" style="margin:0 auto">↻ Ver histórico atualizado</button>
  </div>`;
}

function confirmRevert(title, details, onConfirm){
  showConfirm(title, 'Deseja reverter para este estado anterior?', details.map(d => ({label:d.label, val:d.val})), onConfirm);
}

/* Bloqueia reverter uma reversão (evita loop redundante). */
function isAlreadyReverted(e){ return (e.acao || '').includes('revert'); }

/* Monta o alvo da reversão a partir do que a entrada de histórico alterou.
   Uma entrada pode ter mexido só em uso (UF/cidade/prof), só em tags ou só no
   motivo/bloqueio — restauramos apenas os grupos presentes em `antes`. */
function buildRevertTarget(e, caso){
  const a = e.antes || {};
  const payload = {caso_id: caso.id, row: caso.row};
  const details = [{label:'Caso', val:e.caso_id}];
  const hasUso = ('ufs' in a) || ('cidades' in a) || ('clientes' in a);
  if(hasUso){
    const ufs = a.ufs||[], cidades = a.cidades||[], clientes = a.clientes||[];
    payload.set_uso = '1';
    payload.ufs = ufs.join('/'); payload.cidades = cidades.join('/'); payload.clientes = clientes.join('/');
    details.push({label:'UFs → antes', val: ufs.join(', ')||'(vazio)'});
    details.push({label:'Cidades → antes', val: cidades.map(cap).join(', ')||'(vazio)'});
    details.push({label:'Profissionais → antes', val: clientes.join(', ')||'(vazio)'});
  }
  if('tags' in a){
    payload.set_tags = '1';
    payload.tags = (a.tags||[]).join('/');
    details.push({label:'Tags → antes', val:(a.tags||[]).join(', ')||'(vazio)'});
  }
  if('motivo_bloqueio' in a){
    payload.set_motivo = '1';
    payload.motivo = a.motivo_bloqueio||'';
    details.push({label:'Motivo → antes', val:(a.motivo_bloqueio||'(vazio)')});
  }
  return {payload, details, hasAny: hasUso || ('tags' in a) || ('motivo_bloqueio' in a)};
}

function revertSummary(payload){
  const parts = [];
  if(payload.set_uso === '1'){
    parts.push(`UFs: ${(payload.ufs||'').split('/').filter(Boolean).join(', ')||'(vazio)'}`);
    parts.push(`Cidades: ${(payload.cidades||'').split('/').filter(Boolean).map(cap).join(', ')||'(vazio)'}`);
    parts.push(`Profissionais: ${(payload.clientes||'').split('/').filter(Boolean).join(', ')||'(vazio)'}`);
  }
  if(payload.set_tags === '1') parts.push(`Tags: ${(payload.tags||'').split('/').filter(Boolean).join(', ')||'(vazio)'}`);
  if(payload.set_motivo === '1') parts.push(`Motivo: ${payload.motivo||'(vazio)'}`);
  return parts.join('\n');
}

async function revertEntry(gi, ei){
  const body = document.getElementById('hist-body');
  const groups = body._groups;
  if(!groups) return;
  const e = groups[gi].entries[ei];
  if(!e || !e.antes){ showToast('Esta entrada não tem estado anterior para reverter.'); return; }

  if(isAlreadyReverted(e)){
    showToast('Esta entrada já é uma reversão — não pode ser revertida novamente.');
    return;
  }

  const caso = casos.find(c => c.id === e.caso_id);
  if(!caso){ showToast('Caso não encontrado na planilha atual. Pode ter sido removido ou estar em outra base.'); return; }

  const {payload, details, hasAny} = buildRevertTarget(e, caso);
  if(!hasAny){ showToast('Esta entrada não tem dados restauráveis.'); return; }

  confirmRevert('Reverter esta alteração', details, async () => {
    histLoading(true, `Revertendo ${e.caso_id}...`);
    try{
      const r = await api('revert_caso', payload, 'POST');
      await loadCasos(true);
      if(r.ok && r.verified){
        histSuccess(`${e.caso_id} revertido e confirmado!`, revertSummary(payload));
      } else if(r.ok){
        histLoading(false); loadHistorico();
        showToast('⚠ Reversão enviada, mas a verificação automática não bateu. Confira o caso manualmente.');
      } else {
        histLoading(false); loadHistorico();
        showToast('Erro ao reverter: '+(r.error||''));
      }
    } catch(err){
      histLoading(false);
      loadHistorico();
      showToast('Erro: '+err.message);
    }
  });
}

async function revertGroup(gi){
  const body = document.getElementById('hist-body');
  const groups = body._groups;
  if(!groups) return;
  const g = groups[gi];

  const revertable = g.entries.filter(e => e.antes && !isAlreadyReverted(e));
  if(!revertable.length){
    showToast('Nenhuma entrada revertível neste grupo (todas já são reversões).');
    return;
  }

  const details = [
    {label:'Usuário', val:g.usuario},
    {label:'Entradas', val:`${revertable.length} de ${g.entries.length} (${g.entries.length-revertable.length} já revertidas ignoradas)`},
    {label:'Casos', val:[...new Set(revertable.map(e => e.caso_id))].join(', ')},
  ];

  confirmRevert('Reverter grupo inteiro', details, async () => {
    histLoading(true, `Revertendo ${revertable.length} entrada(s)...`);
    let ok = 0, unverified = 0;
    const errs = [];
    for(const e of revertable){
      const caso = casos.find(c => c.id === e.caso_id);
      if(!caso){ errs.push(`${e.caso_id}: não encontrado`); continue; }
      const {payload, hasAny} = buildRevertTarget(e, caso);
      if(!hasAny){ errs.push(`${e.caso_id}: sem dados restauráveis`); continue; }
      try{
        const r = await api('revert_caso', payload, 'POST');
        if(r.ok && r.verified) ok++;
        else if(r.ok){ ok++; unverified++; }
        else errs.push(`${e.caso_id}: ${r.error||'erro'}`);
      } catch(err){ errs.push(`${e.caso_id}: ${err.message}`); }
    }
    await loadCasos(true);
    if(errs.length){
      histLoading(false);
      loadHistorico();
      showToast(`${ok} revertidos, ${errs.length} erro(s): ${errs.slice(0,3).join('; ')}`);
    } else {
      const extra = unverified ? `\n(${unverified} sem verificação automática — confira manualmente.)` : '';
      histSuccess(`Grupo revertido com sucesso!`, `${ok} caso(s) revertidos para o estado anterior.${extra}`);
    }
  });
}

/* Auditoria de qualidade dos dados (UFs, cidades). */
let _lastAuditReport = null;
let _auditCurrentBase = 'all';

async function runDataAudit(){
  const box = document.getElementById('audit-result');
  const expBtn = document.getElementById('audit-export-btn');
  box.style.display = 'block';
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Varrendo todas as bases — pode demorar alguns segundos...</div>';
  expBtn.style.display = 'none';
  try{
    const r = await api('audit_data');
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    _lastAuditReport = r.report;
    _auditCurrentBase = 'all';
    renderAuditReport();
    expBtn.style.display = 'inline-flex';
  } catch(e){
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

function switchAuditBase(baseKey){
  _auditCurrentBase = baseKey;
  renderAuditReport();
}

/* ===== Sincronização Drive ↔ planilha ===== */
let _syncDriveOnly = [];

async function runSyncPreview(){
  const box = document.getElementById('sync-result');
  const btn = document.getElementById('sync-check-btn');
  box.style.display = 'block';
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Varrendo o Drive e cruzando com a planilha — pode demorar...</div>';
  if(btn) btn.disabled = true;
  try{
    const r = await api('sync_preview');
    if(btn) btn.disabled = false;
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    _syncDriveOnly = r.drive_only || [];
    renderSyncResult(r);
  } catch(e){
    if(btn) btn.disabled = false;
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

function renderSyncResult(r){
  const box = document.getElementById('sync-result');
  const driveOnly = r.drive_only || [];
  const sheetOnly = r.sheet_only || [];
  const chip = (id, bg, tx) => `<span style="padding:2px 8px;background:${bg};color:${tx};border-radius:10px;font-size:11px;font-family:var(--font-mono)">${esc(id)}</span>`;

  let html = `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:1rem">
    <span>📁 Drive: <b>${r.drive_total||0}</b> casos</span>
    <span>📋 Planilha: <b>${r.sheet_total||0}</b> casos</span>
  </div>`;

  // Drive sem linha → criar
  html += `<div style="margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.4rem;color:${driveOnly.length?'var(--atx)':'var(--gtx)'}">
      ${driveOnly.length ? `⚠ ${driveOnly.length} caso(s) no Drive sem linha na planilha` : '✅ Nenhum caso órfão no Drive'}
    </div>`;
  if(driveOnly.length){
    html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:.6rem;max-height:140px;overflow:auto">
      ${driveOnly.map(id => chip(id, 'var(--abg)', 'var(--atx)')).join('')}</div>
      <button class="btn bp" style="padding:6px 13px;font-size:12px" onclick="applySyncCreate()">Criar ${driveOnly.length} linha(s) na planilha</button>`;
  }
  html += `</div>`;

  // Planilha sem fotos → pendente
  html += `<div>
    <div style="font-weight:700;margin-bottom:.4rem;color:${sheetOnly.length?'var(--rtx)':'var(--gtx)'}">
      ${sheetOnly.length ? `⚠ ${sheetOnly.length} caso(s) na planilha sem nenhum arquivo (pendente de fotos)` : '✅ Toda linha tem arquivos'}
    </div>`;
  if(sheetOnly.length){
    html += `<div style="display:flex;flex-wrap:wrap;gap:4px;max-height:140px;overflow:auto">
      ${sheetOnly.map(id => chip(id, 'var(--rbg)', 'var(--rtx)')).join('')}</div>`;
  }
  html += `</div>`;

  box.innerHTML = html;
}

async function applySyncCreate(){
  if(!_syncDriveOnly.length) return;
  if(!confirm(`Criar ${_syncDriveOnly.length} linha(s) na planilha (só o ID, demais colunas vazias)?`)) return;
  const box = document.getElementById('sync-result');
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Criando linhas na planilha...</div>';
  try{
    const r = await api('sync_apply', {ids: _syncDriveOnly.join(',')}, 'POST');
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    const created = (r.created||[]).length, skipped = (r.skipped||[]).length, errors = (r.errors||[]).length;
    let msg = `<div style="color:var(--gtx);font-weight:700;margin-bottom:.5rem">✅ ${created} linha(s) criada(s).</div>`;
    if(skipped) msg += `<div style="color:var(--tx2);font-size:12px">${skipped} já existia(m).</div>`;
    if(errors)  msg += `<div style="color:var(--rtx);font-size:12px;margin-top:.4rem">Erros (${errors}):<br>${(r.errors||[]).map(e=>esc(e)).join('<br>')}</div>`;
    msg += `<div style="margin-top:.75rem"><button class="btn bs" style="padding:6px 13px;font-size:12px" onclick="runSyncPreview()">Verificar de novo</button></div>`;
    box.innerHTML = msg;
    if(typeof loadCasos === 'function') loadCasos(true);
  } catch(e){
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

/* ===== Sincronização via modal (disponível a qualquer usuário logado) ===== */
let _syncModalDriveOnly = [];

/* Item único do menu: recarrega os casos em segundo plano E abre o
   verificador Drive↔planilha. */
function syncAll(){
  if(typeof loadCasos === 'function') loadCasos(true);
  openSyncModal();
}

function openSyncModal(){
  const m = document.getElementById('sync-modal');
  if(!m) return;
  m.style.display = 'flex';
  runSyncModalPreview();
}

function closeSyncModal(){
  const m = document.getElementById('sync-modal');
  if(m) m.style.display = 'none';
}

async function runSyncModalPreview(){
  const box = document.getElementById('sync-modal-body');
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Varrendo o Drive e cruzando com a planilha — pode demorar...</div>';
  try{
    const r = await api('sync_preview');
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    _syncModalDriveOnly = r.drive_only || [];
    renderSyncModalResult(r);
  } catch(e){
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

function renderSyncModalResult(r){
  const box = document.getElementById('sync-modal-body');
  const driveOnly = r.drive_only || [];
  const sheetOnly = r.sheet_only || [];
  const chip = (id, bg, tx) => `<span style="padding:2px 8px;background:${bg};color:${tx};border-radius:10px;font-size:11px;font-family:var(--font-mono)">${esc(id)}</span>`;

  let html = `<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:1rem">
    <span>📁 Drive: <b>${r.drive_total||0}</b> casos</span>
    <span>📋 Planilha: <b>${r.sheet_total||0}</b> casos</span>
  </div>`;

  html += `<div style="margin-bottom:1rem">
    <div style="font-weight:700;margin-bottom:.4rem;color:${driveOnly.length?'var(--atx)':'var(--gtx)'}">
      ${driveOnly.length ? `⚠ ${driveOnly.length} caso(s) novo(s) no Drive sem linha na planilha` : '✅ Nenhum caso novo no Drive'}
    </div>`;
  if(driveOnly.length){
    html += `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:.6rem;max-height:140px;overflow:auto">
      ${driveOnly.map(id => chip(id, 'var(--abg)', 'var(--atx)')).join('')}</div>
      <button class="btn bp" style="padding:6px 13px;font-size:12px" onclick="applySyncModalCreate()">Criar ${driveOnly.length} linha(s) na planilha</button>`;
  }
  html += `</div>`;

  html += `<div>
    <div style="font-weight:700;margin-bottom:.4rem;color:${sheetOnly.length?'var(--rtx)':'var(--gtx)'}">
      ${sheetOnly.length ? `⚠ ${sheetOnly.length} caso(s) na planilha sem nenhum arquivo (pendente de fotos)` : '✅ Toda linha tem arquivos'}
    </div>`;
  if(sheetOnly.length){
    html += `<div style="display:flex;flex-wrap:wrap;gap:4px;max-height:140px;overflow:auto">
      ${sheetOnly.map(id => chip(id, 'var(--rbg)', 'var(--rtx)')).join('')}</div>`;
  }
  html += `</div>`;

  box.innerHTML = html;
}

async function applySyncModalCreate(){
  if(!_syncModalDriveOnly.length) return;
  if(!confirm(`Criar ${_syncModalDriveOnly.length} linha(s) na planilha (só o ID na coluna de caso, demais colunas vazias)?`)) return;
  const box = document.getElementById('sync-modal-body');
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Criando linhas na planilha...</div>';
  try{
    const r = await api('sync_apply', {ids: _syncModalDriveOnly.join(',')}, 'POST');
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    const created = (r.created||[]).length, skipped = (r.skipped||[]).length, errors = (r.errors||[]).length;
    let msg = `<div style="color:var(--gtx);font-weight:700;margin-bottom:.5rem">✅ ${created} linha(s) criada(s).</div>`;
    if(skipped) msg += `<div style="color:var(--tx2);font-size:12px">${skipped} já existia(m).</div>`;
    if(errors)  msg += `<div style="color:var(--rtx);font-size:12px;margin-top:.4rem">Erros (${errors}):<br>${(r.errors||[]).map(e=>esc(e)).join('<br>')}</div>`;
    msg += `<div style="margin-top:.75rem;display:flex;gap:8px"><button class="btn bs" style="padding:6px 13px;font-size:12px" onclick="runSyncModalPreview()">Verificar de novo</button><button class="btn bp" style="padding:6px 13px;font-size:12px" onclick="closeSyncModal()">Fechar</button></div>`;
    box.innerHTML = msg;
    if(typeof loadCasos === 'function') loadCasos(true);
  } catch(e){
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

/* Conta as ocorrências por base em todas as 4 categorias.
   Devolve um objeto { baseKey: count } com a contagem total por base. */
function auditCountsByBase(report){
  const counts = {};
  const buckets = [report.uf_issues, report.cidade_unknown, report.cidade_wrong_uf, report.cidade_dups];
  buckets.forEach(arr => (arr||[]).forEach(e => {
    counts[e.base] = (counts[e.base] || 0) + 1;
  }));
  return counts;
}

function renderAuditReport(){
  if(!_lastAuditReport) return;
  const full = _lastAuditReport;
  const box = document.getElementById('audit-result');

  /* Aplica o filtro de base ao conjunto antes de renderizar. */
  const filterFn = e => _auditCurrentBase === 'all' || e.base === _auditCurrentBase;
  const r = {
    csv_loaded: full.csv_loaded,
    csv_error:  full.csv_error,
    errors:     full.errors,
    uf_issues:        (full.uf_issues||[]).filter(filterFn),
    cidade_unknown:   (full.cidade_unknown||[]).filter(filterFn),
    cidade_wrong_uf:  (full.cidade_wrong_uf||[]).filter(filterFn),
    cidade_dups:      (full.cidade_dups||[]).filter(filterFn),
    summary: {
      ...full.summary,
      uf_invalid_count:     0,
      cidade_unknown_count: 0,
      cidade_wrong_uf_count:0,
      cidade_dups_count:    0,
    },
  };
  r.summary.uf_invalid_count      = r.uf_issues.length;
  r.summary.cidade_unknown_count  = r.cidade_unknown.length;
  r.summary.cidade_wrong_uf_count = r.cidade_wrong_uf.length;
  r.summary.cidade_dups_count     = r.cidade_dups.length;
  const s = r.summary;
  let html = '';

  /* Abas de base. Mostra "Todas" + cada base que aparece no relatório, com a
     contagem total de ocorrências. */
  const byBase = auditCountsByBase(full);
  const bases = Object.keys(byBase).sort();
  const totalAll = Object.values(byBase).reduce((acc, n) => acc + n, 0);
  let tabs = '';
  const tabCss = (active) => `padding:6px 14px;border-radius:20px;border:0.5px solid var(--bds);cursor:pointer;font-size:12px;font-weight:500;background:${active?'var(--accent)':'transparent'};color:${active?'#fff':'var(--tx2)'};transition:all .15s`;
  tabs += `<button onclick="switchAuditBase('all')" style="${tabCss(_auditCurrentBase==='all')}">Todas <span style="opacity:.7;margin-left:4px">(${totalAll})</span></button>`;
  bases.forEach(b => {
    tabs += `<button onclick="switchAuditBase('${esc(b).replace(/'/g,"\\'")}')" style="${tabCss(_auditCurrentBase===b)}">${esc(b)} <span style="opacity:.7;margin-left:4px">(${byBase[b]})</span></button>`;
  });
  html += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.75rem">${tabs}</div>`;

  /* Resumo */
  html += `<div style="background:var(--bg);padding:.75rem 1rem;border-radius:var(--rs);border:1px solid var(--bd);margin-bottom:.75rem">
    <div style="font-weight:700;margin-bottom:.4rem">Resumo${_auditCurrentBase!=='all'?` — base ${esc(_auditCurrentBase)}`:''}</div>
    <div style="font-size:12px;color:var(--tx2);line-height:1.7">
      ${s.bases||0} base(s) · ${s.casos||0} caso(s) varridos · ${s.uf_entries||0} entradas de UF · ${s.cidade_entries||0} entradas de cidade<br>
      ${r.csv_loaded
        ? `✓ CSV de coordenadas carregado`
        : `<span style="color:var(--rtx)">❌ CSV não carregou: ${esc(r.csv_error||'')}</span>`}
    </div>
  </div>`;

  /* Cards de contagem */
  html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:1rem">
    ${auditCountCard('UFs inválidas', s.uf_invalid_count||0, 'var(--rtx)')}
    ${auditCountCard('Cidades desconhecidas', s.cidade_unknown_count||0, 'var(--rtx)')}
    ${auditCountCard('Cidades em UF errada', s.cidade_wrong_uf_count||0, 'var(--atx)')}
    ${auditCountCard('Duplicatas no caso', s.cidade_dups_count||0, 'var(--atx)')}
  </div>`;

  /* Seção: UFs inválidas */
  if(r.uf_issues.length){
    html += auditSection('UFs inválidas (não estão entre as 27 do Brasil + marcadores)', r.uf_issues, e =>
      `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.uf)}</code></td></tr>`,
      ['Base', 'Caso', 'UF na planilha']);
  }

  /* Seção: cidades desconhecidas */
  if(r.cidade_unknown.length){
    html += auditSection('Cidades não reconhecidas pelo CSV (talvez typo ou abreviação)', r.cidade_unknown, e => {
      const sug = (e.suggestions||[]).map(s => `<span style="font-size:11px;background:var(--gbg);color:var(--gtx);padding:1px 6px;border-radius:8px;margin:1px;display:inline-block">${esc(s.name)}/${esc(s.uf)} (dist ${s.distance})</span>`).join(' ');
      return `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.cidade)}</code></td><td>${sug || '<span style="color:var(--tx3)">sem sugestão próxima</span>'}</td></tr>`;
    }, ['Base', 'Caso', 'Cidade na planilha', 'Sugestões']);
  }

  /* Seção: cidades em UF errada */
  if(r.cidade_wrong_uf.length){
    html += auditSection('Cidades cadastradas em UF que não consta no caso', r.cidade_wrong_uf, e =>
      `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.cidade)}</code></td><td>${esc((e.found_in||[]).join(', '))}</td><td>${esc((e.case_ufs||[]).join(', '))}</td></tr>`,
      ['Base', 'Caso', 'Cidade', 'CSV diz que está em', 'Caso tem UFs']);
  }

  /* Seção: duplicatas com escrita diferente */
  if(r.cidade_dups.length){
    html += auditSection('Mesma cidade com escritas diferentes no mesmo caso', r.cidade_dups, e =>
      `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.a)}</code> e <code>${esc(e.b)}</code></td><td><code>${esc(e.normalized)}</code></td></tr>`,
      ['Base', 'Caso', 'Variações', 'Normalizado']);
  }

  /* Erros de leitura (sempre globais, independem do filtro). */
  if(r.errors && r.errors.length){
    html += `<div style="background:var(--rbg);border:1px solid var(--rtx);border-radius:var(--rs);padding:.75rem;margin-bottom:.75rem;font-size:12px;color:var(--rtx)">
      <div style="font-weight:700;margin-bottom:.3rem">Erros ao ler bases:</div>
      ${r.errors.map(e => `<div>• ${esc(e)}</div>`).join('')}
    </div>`;
  }

  const totalIssues = s.uf_invalid_count + s.cidade_unknown_count + s.cidade_wrong_uf_count + s.cidade_dups_count;
  if(totalIssues === 0 && r.csv_loaded){
    const scopeLabel = _auditCurrentBase === 'all' ? '' : ` na base ${esc(_auditCurrentBase)}`;
    html += `<div style="background:var(--gbg);color:var(--gtx);padding:1rem;border-radius:var(--rs);text-align:center;font-weight:600">✅ Tudo OK${scopeLabel} — nenhuma inconsistência encontrada.</div>`;
  }

  box.innerHTML = html;
}

function auditCountCard(label, value, color){
  const c = value > 0 ? color : 'var(--tx3)';
  return `<div style="background:var(--bg);border:1px solid var(--bd);border-radius:var(--rs);padding:.6rem .75rem;text-align:center">
    <div style="font-size:22px;font-weight:700;color:${c}">${value}</div>
    <div style="font-size:10px;color:var(--tx2);margin-top:2px">${label}</div>
  </div>`;
}

function auditSection(title, rows, rowFn, headers){
  return `<details open style="margin-bottom:.75rem;background:var(--bg);border:1px solid var(--bd);border-radius:var(--rs);overflow:hidden">
    <summary style="padding:.6rem .85rem;cursor:pointer;font-weight:700;font-size:13px;background:var(--sf)">${esc(title)} (${rows.length})</summary>
    <div style="overflow-x:auto;max-height:300px;overflow-y:auto">
      <table style="width:100%;border-collapse:collapse;font-size:11px">
        <thead style="background:var(--bg);position:sticky;top:0">
          <tr>${headers.map(h => `<th style="padding:.4rem .6rem;text-align:left;border-bottom:1px solid var(--bds);font-weight:600;color:var(--tx2);text-transform:uppercase;letter-spacing:.04em;font-size:10px">${esc(h)}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows.map(rowFn).join('')}</tbody>
      </table>
    </div>
  </details>`;
}

function exportAuditReport(){
  if(!_lastAuditReport) return;
  const r = _lastAuditReport;
  const s = r.summary || {};
  const lines = [];
  lines.push('=== AUDITORIA DE DADOS ===');
  lines.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  lines.push(`Bases: ${s.bases||0} · Casos: ${s.casos||0}`);
  lines.push(`CSV: ${r.csv_loaded ? 'OK' : 'ERRO ('+(r.csv_error||'')+')'}`);
  lines.push('');

  if(r.uf_issues && r.uf_issues.length){
    lines.push(`-- UFs inválidas (${r.uf_issues.length}) --`);
    r.uf_issues.forEach(e => lines.push(`  ${e.base}/${e.caso_id}: ${e.uf}`));
    lines.push('');
  }
  if(r.cidade_unknown && r.cidade_unknown.length){
    lines.push(`-- Cidades não reconhecidas (${r.cidade_unknown.length}) --`);
    r.cidade_unknown.forEach(e => {
      const sug = (e.suggestions||[]).map(s => `${s.name}/${s.uf}`).join(', ');
      lines.push(`  ${e.base}/${e.caso_id}: "${e.cidade}"${sug?'  → sugestões: '+sug:''}`);
    });
    lines.push('');
  }
  if(r.cidade_wrong_uf && r.cidade_wrong_uf.length){
    lines.push(`-- Cidades em UF errada (${r.cidade_wrong_uf.length}) --`);
    r.cidade_wrong_uf.forEach(e =>
      lines.push(`  ${e.base}/${e.caso_id}: "${e.cidade}" só existe em ${(e.found_in||[]).join(',')} mas o caso tem [${(e.case_ufs||[]).join(',')}]`)
    );
    lines.push('');
  }
  if(r.cidade_dups && r.cidade_dups.length){
    lines.push(`-- Duplicatas no mesmo caso (${r.cidade_dups.length}) --`);
    r.cidade_dups.forEach(e =>
      lines.push(`  ${e.base}/${e.caso_id}: "${e.a}" e "${e.b}" normalizam para ${e.normalized}`)
    );
    lines.push('');
  }

  const blob = new Blob([lines.join('\n')], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auditoria_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Configuração e auditoria de distâncias (raio mínimo entre cidades). */
let _lastDistAudit = null;
let _distAuditBase = 'all';

async function loadDistanceConfig(){
  const input = document.getElementById('dist-radius-input');
  if(!input) return;
  try{
    const r = await api('get_distance_config');
    if(r.ok) input.value = r.radius_km;
  } catch(e){}
}

async function saveDistanceConfig(){
  const input = document.getElementById('dist-radius-input');
  const msg = document.getElementById('dist-radius-msg');
  const val = parseFloat(input.value);
  if(!(val >= 1 && val <= 5000)){
    msg.textContent = 'Informe um valor entre 1 e 5000 km.';
    msg.style.color = 'var(--rtx)';
    return;
  }
  msg.textContent = 'Salvando...';
  msg.style.color = 'var(--tx3)';
  try{
    const r = await api('set_distance_config', {radius_km: val}, 'POST');
    if(r.ok){
      input.value = r.radius_km;
      msg.textContent = r.msg || 'Raio salvo.';
      msg.style.color = 'var(--gtx)';
      showToast(`Raio mínimo atualizado para ${r.radius_km} km`);
    } else {
      msg.textContent = r.error || 'Erro ao salvar.';
      msg.style.color = 'var(--rtx)';
    }
  } catch(e){
    msg.textContent = `Erro de conexão: ${e.message}`;
    msg.style.color = 'var(--rtx)';
  }
}

async function runDistanceAudit(){
  const box = document.getElementById('dist-audit-result');
  const expBtn = document.getElementById('dist-audit-export-btn');
  box.style.display = 'block';
  box.innerHTML = '<div style="padding:1rem;color:var(--tx2)"><span class="spin"></span> Varrendo todas as bases — pode demorar alguns segundos...</div>';
  expBtn.style.display = 'none';
  try{
    const r = await api('audit_distances');
    if(!r.ok){ box.innerHTML = `<div style="color:var(--rtx)">Erro: ${esc(r.error||'')}</div>`; return; }
    _lastDistAudit = r.report;
    _distAuditBase = 'all';
    renderDistanceAudit();
    expBtn.style.display = 'inline-flex';
  } catch(e){
    box.innerHTML = `<div style="color:var(--rtx)">Erro de conexão: ${esc(e.message)}</div>`;
  }
}

function switchDistAuditBase(baseKey){
  _distAuditBase = baseKey;
  renderDistanceAudit();
}

function renderDistanceAudit(){
  if(!_lastDistAudit) return;
  const full = _lastDistAudit;
  const box = document.getElementById('dist-audit-result');

  const filterFn = e => _distAuditBase === 'all' || e.base === _distAuditBase;
  const conflicts  = (full.conflicts||[]).filter(filterFn);
  const unresolved = (full.unresolved||[]).filter(filterFn);
  const s = full.summary || {};

  /* Abas por base — contagem de pares em conflito. */
  const byBase = {};
  (full.conflicts||[]).forEach(e => byBase[e.base] = (byBase[e.base]||0) + 1);
  const bases = Object.keys(byBase).sort();
  const totalAll = Object.values(byBase).reduce((acc, n) => acc + n, 0);
  const tabCss = (active) => `padding:6px 14px;border-radius:20px;border:0.5px solid var(--bds);cursor:pointer;font-size:12px;font-weight:500;background:${active?'var(--accent)':'transparent'};color:${active?'#fff':'var(--tx2)'};transition:all .15s`;
  let tabs = `<button onclick="switchDistAuditBase('all')" style="${tabCss(_distAuditBase==='all')}">Todas <span style="opacity:.7;margin-left:4px">(${totalAll})</span></button>`;
  bases.forEach(b => {
    tabs += `<button onclick="switchDistAuditBase('${esc(b).replace(/'/g,"\\'")}')" style="${tabCss(_distAuditBase===b)}">${esc(b)} <span style="opacity:.7;margin-left:4px">(${byBase[b]})</span></button>`;
  });

  let html = `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.75rem">${tabs}</div>`;

  html += `<div style="background:var(--bg);padding:.75rem 1rem;border-radius:var(--rs);border:1px solid var(--bd);margin-bottom:.75rem">
    <div style="font-weight:700;margin-bottom:.4rem">Resumo${_distAuditBase!=='all'?` — base ${esc(_distAuditBase)}`:''}</div>
    <div style="font-size:12px;color:var(--tx2);line-height:1.7">
      Raio configurado: <b>${esc(String(full.radius_km))} km</b><br>
      ${s.bases||0} base(s) · ${s.casos||0} caso(s) varridos<br>
      ${full.csv_loaded
        ? `✓ CSV de coordenadas carregado`
        : `<span style="color:var(--rtx)">❌ CSV não carregou: ${esc(full.csv_error||'')}</span>`}
    </div>
  </div>`;

  html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:1rem">
    ${auditCountCard('Pares em conflito', conflicts.length, 'var(--rtx)')}
    ${auditCountCard('Cidades sem coordenada', unresolved.length, 'var(--atx)')}
  </div>`;

  if(conflicts.length){
    html += auditSection('Pares de cidades dentro do raio mínimo', conflicts, e =>
      `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.cidade_a)}</code>/${esc(e.uf_a)}</td><td><code>${esc(e.cidade_b)}</code>/${esc(e.uf_b)}</td><td>${esc(String(e.distancia_km))} km</td><td>${esc(String(e.raio_km))} km</td></tr>`,
      ['Base', 'Caso', 'Cidade A', 'Cidade B', 'Distância', 'Limite do par']);
  }

  if(unresolved.length){
    html += auditSection('Cidades sem coordenada no CSV (não entram no cálculo)', unresolved, e =>
      `<tr><td>${esc(e.base)}</td><td>${esc(e.caso_id)}</td><td><code>${esc(e.cidade)}</code></td></tr>`,
      ['Base', 'Caso', 'Cidade']);
  }

  if(full.errors && full.errors.length){
    html += `<div style="background:var(--rbg);border:1px solid var(--rtx);border-radius:var(--rs);padding:.75rem;margin-bottom:.75rem;font-size:12px;color:var(--rtx)">
      <div style="font-weight:700;margin-bottom:.3rem">Erros ao ler bases:</div>
      ${full.errors.map(e => `<div>• ${esc(e)}</div>`).join('')}
    </div>`;
  }

  if(conflicts.length === 0 && full.csv_loaded){
    const scopeLabel = _distAuditBase === 'all' ? '' : ` na base ${esc(_distAuditBase)}`;
    html += `<div style="background:var(--gbg);color:var(--gtx);padding:1rem;border-radius:var(--rs);text-align:center;font-weight:600">✅ Nenhum conflito de distância${scopeLabel} — todos os casos respeitam o raio de ${esc(String(full.radius_km))} km.</div>`;
  }

  box.innerHTML = html;
}

function exportDistanceAudit(){
  if(!_lastDistAudit) return;
  const r = _lastDistAudit;
  const s = r.summary || {};
  const lines = [];
  lines.push('=== AUDITORIA DE DISTÂNCIAS ===');
  lines.push(`Data: ${new Date().toLocaleString('pt-BR')}`);
  lines.push(`Raio mínimo configurado: ${r.radius_km} km`);
  lines.push(`Bases: ${s.bases||0} · Casos: ${s.casos||0}`);
  lines.push(`CSV: ${r.csv_loaded ? 'OK' : 'ERRO ('+(r.csv_error||'')+')'}`);
  lines.push('');

  if(r.conflicts && r.conflicts.length){
    lines.push(`-- Pares em conflito (${r.conflicts.length}) --`);
    r.conflicts.forEach(e =>
      lines.push(`  ${e.base}/${e.caso_id}: ${e.cidade_a}/${e.uf_a} <-> ${e.cidade_b}/${e.uf_b} = ${e.distancia_km} km (limite do par: ${e.raio_km} km)`)
    );
    lines.push('');
  } else {
    lines.push('Nenhum conflito de distância encontrado.');
    lines.push('');
  }

  if(r.unresolved && r.unresolved.length){
    lines.push(`-- Cidades sem coordenada no CSV (${r.unresolved.length}) --`);
    r.unresolved.forEach(e => lines.push(`  ${e.base}/${e.caso_id}: "${e.cidade}"`));
    lines.push('');
  }

  const blob = new Blob([lines.join('\n')], {type:'text/plain;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `auditoria_distancias_${new Date().toISOString().slice(0,10)}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* Cidades coringa — raio mínimo reduzido em cidades populosas. */
let _coringaDefaultKm = null;
let coringaCities = [];

/* Carrega os municípios da UF escolhida (API do IBGE) para o autocomplete,
   espelhando o comportamento do formulário de registro de uso. */
async function onCoringaUF(){
  const uf = document.getElementById('coringa-uf').value;
  const ci = document.getElementById('coringa-cidade');
  ci.value = ''; ci.dataset.val = '';
  coringaCities = [];
  document.getElementById('coringa-cidade-dd').classList.remove('open');
  if(!uf){
    ci.readOnly = true;
    ci.placeholder = 'Selecione a UF primeiro...';
    return;
  }
  ci.readOnly = true;
  ci.placeholder = 'Carregando cidades...';
  try{
    coringaCities = await fetchCities(uf);
  } catch(e){
    coringaCities = [];
  }
  ci.readOnly = false;
  ci.placeholder = 'Pesquise a cidade...';
}

function onCoringaCityInp(){
  const ci = document.getElementById('coringa-cidade');
  renderFormDD('coringa-cidade-dd', coringaCities, ci.value, c => {
    ci.value = cap(c);
    ci.dataset.val = c;
    document.getElementById('coringa-cidade-dd').classList.remove('open');
  });
}

function openCoringaCityDD(){
  if(!document.getElementById('coringa-cidade').readOnly) onCoringaCityInp();
}

async function loadCoringas(){
  const box = document.getElementById('coringas-list');
  if(!box) return;
  box.innerHTML = '<span style="font-size:12px;color:var(--tx3)"><span class="spin"></span> Carregando coringas...</span>';
  try{
    const r = await api('list_distance_overrides');
    if(!r.ok){ box.innerHTML = '<span style="font-size:12px;color:var(--rtx)">Erro ao carregar.</span>'; return; }
    _coringaDefaultKm = r.default_km;
    const dk = document.getElementById('coringa-default-km');
    if(dk) dk.textContent = r.default_km;
    const list = Array.isArray(r.overrides) ? r.overrides : [];
    if(!list.length){
      box.innerHTML = '<span style="font-size:12px;color:var(--tx3)">Nenhuma cidade coringa cadastrada. Use o formulário abaixo para criar a primeira.</span>';
      return;
    }
    const th = 'padding:.4rem .6rem;text-align:left;border-bottom:1px solid var(--bds);font-weight:600;color:var(--tx2);font-size:10px;text-transform:uppercase;letter-spacing:.04em';
    const td = 'padding:.4rem .6rem;border-bottom:1px solid var(--bd)';
    box.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr>
        <th style="${th}">Cidade</th><th style="${th}">UF</th><th style="${th}">Raio</th><th style="border-bottom:1px solid var(--bds)"></th>
      </tr></thead>
      <tbody>${list.map(o => {
        const warn = (_coringaDefaultKm != null && o.radius_km >= _coringaDefaultKm)
          ? ` <span title="Raio maior ou igual ao padrão — não terá efeito prático" style="color:var(--atx)">⚠</span>` : '';
        const unknown = o.known ? '' : ` <span title="Cidade não encontrada no CSV de coordenadas atual" style="color:var(--rtx);font-size:10px">(fora do CSV)</span>`;
        return `<tr>
          <td style="${td}">${esc(o.cidade)}${unknown}</td>
          <td style="${td}">${esc(o.uf)}</td>
          <td style="${td}"><b>${esc(String(o.radius_km))} km</b>${warn}</td>
          <td style="${td};text-align:right"><button class="btn-revert" style="border-color:var(--rtx);color:var(--rtx);padding:3px 9px;font-size:11px" onclick="removeCoringa('${esc(o.key).replace(/'/g,"\\'")}', '${esc(o.cidade).replace(/'/g,"\\'")}', '${esc(o.uf)}')">Remover</button></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } catch(e){
    box.innerHTML = '<span style="font-size:12px;color:var(--rtx)">Erro de conexão.</span>';
  }
}

async function addCoringa(){
  const cidEl  = document.getElementById('coringa-cidade');
  const ufEl   = document.getElementById('coringa-uf');
  const raioEl = document.getElementById('coringa-raio');
  const err    = document.getElementById('coringa-err');
  err.textContent = '';
  const uf = ufEl.value;
  let cidade = (cidEl.dataset.val || '').toUpperCase();
  /* Também aceita o texto digitado se bater exatamente com uma cidade da lista. */
  if(!cidade){
    const typed = cidEl.value.trim().toUpperCase();
    if(typed && coringaCities.includes(typed)) cidade = typed;
  }
  const radius_km = parseFloat(raioEl.value);
  if(!uf){ err.textContent = 'Selecione a UF.'; return; }
  if(!cidade){ err.textContent = 'Selecione uma cidade da lista (digite e escolha no menu).'; return; }
  if(!(radius_km >= 1 && radius_km <= 5000)){ err.textContent = 'Informe um raio entre 1 e 5000 km.'; return; }
  try{
    const r = await api('add_distance_override', {cidade, uf, radius_km}, 'POST');
    if(r.ok){
      showToast(r.msg || 'Coringa salvo.');
      cidEl.value = ''; cidEl.dataset.val = ''; cidEl.readOnly = true;
      cidEl.placeholder = 'Selecione a UF primeiro...';
      ufEl.value = '';
      raioEl.value = '';
      coringaCities = [];
      loadCoringas();
    } else err.textContent = r.error || 'Erro.';
  } catch(e){ err.textContent = 'Erro de conexão.'; }
}

function removeCoringa(key, cidade, uf){
  showConfirm(
    'Remover cidade coringa',
    `Remover <b>${esc(cidade)}/${esc(uf)}</b> da lista de coringas? Ela volta a usar o raio padrão.`,
    [{label:'Cidade', val:`${cidade}/${uf}`}],
    async () => {
      try{
        const r = await api('remove_distance_override', {key}, 'POST');
        if(r.ok){
          showToast(r.msg || 'Coringa removido.');
          loadCoringas();
        } else showToast('Erro: '+(r.error||''));
      } catch(e){ showToast('Erro de conexão.'); }
    }
  );
}

/* Gerenciamento de tags canônicas (vocabulário controlado). */
async function loadCanonicalTagsPanel(){
  const box = document.getElementById('canonical-tags-list');
  if(!box) return;
  box.innerHTML = '<span style="font-size:12px;color:var(--tx3)"><span class="spin"></span> Carregando tags...</span>';
  try{
    const r = await api('list_canonical_tags');
    if(!r.ok){ box.innerHTML = '<span style="font-size:12px;color:var(--rtx)">Erro ao carregar.</span>'; return; }
    canonicalTags = Array.isArray(r.tags) ? r.tags : [];
    if(!canonicalTags.length){
      box.innerHTML = '<span style="font-size:12px;color:var(--tx3)">Nenhuma tag cadastrada. Use o formulário abaixo para criar a primeira.</span>';
      return;
    }
    box.innerHTML = canonicalTags.map(t =>
      `<span class="tag-pill" style="font-size:12px">${esc(t)}<span class="x" onclick="confirmRemoveCanonicalTag('${esc(t).replace(/'/g,"\\'")}')" title="Remover esta tag (cascata em todos os casos)">×</span></span>`
    ).join('');
  } catch(e){
    box.innerHTML = '<span style="font-size:12px;color:var(--rtx)">Erro de conexão.</span>';
  }
}

async function addCanonicalTag(){
  const inp = document.getElementById('new-tag');
  const err = document.getElementById('new-tag-err');
  err.textContent = '';
  const tag = inp.value.trim().toUpperCase().replace(/[^\p{L}\p{N} &+-]/gu, '').replace(/\s+/g, ' ').trim();
  if(!tag){ err.textContent = 'Digite uma tag.'; return; }
  if(tag.length > 30){ err.textContent = 'Tag muito longa (máx. 30 chars).'; return; }
  try{
    const r = await api('add_canonical_tag', {tag}, 'POST');
    if(r.ok){
      showToast(r.msg || `Tag "${tag}" adicionada.`);
      if(Array.isArray(r.tags)) canonicalTags = r.tags;
      inp.value = '';
      loadCanonicalTagsPanel();
    } else err.textContent = r.error || 'Erro.';
  } catch(e){ err.textContent = 'Erro de conexão.'; }
}

function confirmRemoveCanonicalTag(tag){
  showConfirm(
    'Remover tag em cascata',
    `Remover a tag <b>${esc(tag)}</b> da lista global E de TODOS os casos em TODAS as bases?`,
    [
      {label:'Tag', val:tag},
      {label:'Cascata', val:'Vai apagar a tag de todos os casos onde aparece'},
      {label:'Atenção', val:'Esta ação não pode ser desfeita facilmente'},
    ],
    async () => {
      const box = document.getElementById('canonical-tags-list');
      box.innerHTML = '<span style="font-size:12px;color:var(--tx3)"><span class="spin"></span> Removendo (pode demorar se a tag está em muitos casos)...</span>';
      try{
        const r = await api('remove_canonical_tag', {tag}, 'POST');
        if(r.ok){
          showToast(r.msg || `Tag "${tag}" removida.`);
          if(Array.isArray(r.tags)) canonicalTags = r.tags;
          loadCanonicalTagsPanel();
          /* Recarrega casos da base ativa pra refletir a remoção em cascata. */
          await loadCasos(true);
        } else {
          showToast('Erro: '+(r.error||''));
          loadCanonicalTagsPanel();
        }
      } catch(e){
        showToast('Erro de conexão.');
        loadCanonicalTagsPanel();
      }
    }
  );
}

function toggleDiag(){ document.getElementById('dp').classList.toggle('open'); }

/* ── Phase G: Audit dashboard (always-on, from casos array) ── */
function renderAuditDash(){
  const el = document.getElementById('s-audit-dash');
  if(!el) return;
  if(typeof casos === 'undefined' || !casos.length){ el.style.display = 'none'; return; }
  const total     = casos.length;
  const blocked   = casos.filter(c => !!c.bloqueado).length;
  const inUse     = casos.filter(c => !c.bloqueado && (c.ufs||[]).some(u => typeof isBlockMarker === 'function' ? !isBlockMarker(u) : true)).length;
  const available = total - blocked - inUse;
  const noTag     = casos.filter(c => !c.bloqueado && (!c.tags || !c.tags.length)).length;
  el.style.display = 'block';
  el.innerHTML = `
    <div class="s-ad-head">
      <span class="s-ad-title">Resumo da base ativa</span>
      <span class="s-ad-sub">Calculado às ${new Date().toLocaleTimeString('pt-BR')}</span>
    </div>
    <div class="s-ad-grid">
      ${_adCard('Total', total, 'var(--tx)')}
      ${_adCard('Disponíveis', available, 'var(--gtx)')}
      ${_adCard('Em uso', inUse, 'var(--rtx)')}
      ${_adCard('Bloqueados', blocked, 'var(--tx3)')}
      ${_adCard('Sem tag', noTag, noTag > 0 ? 'var(--atx)' : 'var(--tx3)')}
    </div>`;
}

function _adCard(label, value, color){
  return `<div class="s-ad-card">
    <div class="s-ad-num" style="color:${color}">${value}</div>
    <div class="s-ad-label">${esc(label)}</div>
  </div>`;
}

/* ── Phase G: Bulk user actions ── */
function onUserCheckChange(user, checked){
  if(checked) _checkedUsers.add(user);
  else        _checkedUsers.delete(user);
  updateUserBulkBar();
}

function updateUserBulkBar(){
  const bar = document.getElementById('s-users-bulk-bar');
  if(!bar) return;
  const n = _checkedUsers.size;
  bar.style.display = n > 0 ? 'flex' : 'none';
  const lbl = bar.querySelector('.s-ub-count');
  if(lbl) lbl.textContent = `${n} usuário${n > 1 ? 's' : ''} selecionado${n > 1 ? 's' : ''}`;
}

function bulkSetProdAccess(allow){
  if(!_checkedUsers.size) return;
  const users = [..._checkedUsers];
  const title = allow ? 'Promover para produção' : 'Voltar para modo teste';
  showConfirm(title, `Aplicar para ${users.length} usuário(s)?`,
    users.map(u => ({label:'Usuário', val:u})),
    async () => {
      for(const u of users)
        await api('set_production_access', {target_user:u, allow:allow?'1':'0'}, 'POST').catch(()=>{});
      showToast(`${users.length} usuário(s) atualizados.`);
      _checkedUsers.clear();
      loadAdminPanel();
    }
  );
}

function bulkRemoveUsers(){
  if(!_checkedUsers.size) return;
  const users = [..._checkedUsers];
  showConfirm('Remover usuários em lote',
    `Remover permanentemente ${users.length} usuário(s)? Esta ação não pode ser desfeita.`,
    users.map(u => ({label:'Usuário', val:u})),
    async () => {
      for(const u of users)
        await api('remove_user', {target_user:u}, 'POST').catch(()=>{});
      showToast(`${users.length} usuário(s) removidos.`);
      _checkedUsers.clear();
      loadAdminPanel();
    }
  );
}

async function runDiag(panel = 'admin'){
  const dbId = panel === 'admin' ? 'db-admin' : 'db';
  const dsId = panel === 'admin' ? 'ds-admin' : 'ds';
  const db = document.getElementById(dbId), ds = document.getElementById(dsId);
  db.style.display = 'block';
  db.innerHTML = '<div style="padding:.5rem 0;font-size:13px;color:var(--tx2)"><span class="spin"></span> Testando conexões...</div>';
  try{
    const r = await api('diagnostico');
    const res = r.result;
    const rows = [
      ['PHP', `${res.php.version}`],
      ['OpenSSL', res.php.openssl],
      ['allow_url_fopen', res.php.allow_url_fopen],
      ['PDO MySQL', res.php.pdo_mysql],
      ['Pasta /thumbs/', res.php.thumb_dir],
      ['MySQL', res.mysql?.msg || '—'],
      ['Tabela audit_log', res.audit_log?.msg || '—'],
      ['Credenciais', res.credentials?.msg || '—'],
      ['SPREADSHEET_ID', res.config?.spreadsheet_id || '—'],
      ['DRIVE_FOLDER_ID', res.config?.drive_folder_id || '—'],
      ['Auth Google', res.google_auth?.msg || '—'],
      ['Sheets', res.sheets?.msg || '—'],
      ['Drive', res.drive?.msg || '—'],
      ['Cache', res.cache_stats?.msg || '—'],
    ];
    const ok = [res.mysql, res.credentials, res.google_auth, res.sheets, res.drive].every(x => x?.ok);
    ds.textContent = ok ? '✓ Tudo OK' : '⚠️ Problemas detectados';
    ds.style.color = ok ? 'var(--gtx)' : 'var(--rtx)';
    db.innerHTML = rows.map(([l,v]) => `<div class="dr"><div class="dl">${l}</div><div class="dv ${String(v).includes('❌')?'cerr':'cok'}">${v}</div></div>`).join('')
      + `<div class="dr"><div class="dl">Teste de log</div><div class="dv"><button class="btn bs" style="padding:4px 10px;font-size:11px" onclick="testLog()">Gravar entrada de teste no histórico</button><span id="test-log-result" style="margin-left:8px;font-size:12px"></span></div></div>`;
  } catch(e){
    ds.textContent = '⚠️ Erro';
    ds.style.color = 'var(--rtx)';
    db.innerHTML = `<div class="cerr" style="padding:.5rem 0;font-size:13px">Erro: ${esc(e.message)}</div>`;
  }
}

async function testLog(){
  const res = document.getElementById('test-log-result');
  res.textContent = 'Testando...';
  res.style.color = 'var(--tx2)';
  try{
    const r = await api('test_log');
    if(r.ok){ res.textContent = '✓ Gravado! Verifique no histórico: caso TESTE-000'; res.style.color = 'var(--gtx)'; }
    else    { res.textContent = '❌ '+r.error; res.style.color = 'var(--rtx)'; }
  } catch(e){ res.textContent = '❌ '+e.message; res.style.color = 'var(--rtx)'; }
}

async function confirmClearAllCache(){
  if(!confirm('Limpar TODO o cache? As thumbs serão baixadas novamente na próxima visualização.')) return;
  try{
    const r = await api('clear_cache', {}, 'POST');
    thumbCache = {};
    showToast(r.ok ? r.msg : 'Erro: '+(r.error||''));
    if(r.ok) await loadCasos(true);
  } catch(e){ showToast('Erro.'); }
}

async function clearCaseCache(casoId){
  try{
    const r = await api('clear_cache', {caso_id: casoId}, 'POST');
    delete thumbCache[casoId];
    showToast(r.ok ? r.msg : 'Erro.');
    renderGrid();
  } catch(e){ showToast('Erro.'); }
}

/* Limpeza de cache em lote. Serve ao cenário de arquivos que entraram na pasta
   errada no Drive: depois de removê-los de lá, o caso continua exibindo a
   listagem antiga porque o cache de thumbs vale 30 dias. Devolve a resposta
   crua do servidor para quem chamou decidir o que fazer com o resultado. */
async function clearCacheBatch(ids){
  try{
    const r = await api('clear_cache', {caso_ids: ids.join(',')}, 'POST');
    if(r.ok) ids.forEach(id => { delete thumbCache[id]; });
    showToast(r.ok ? r.msg : 'Erro: ' + apiErrText(r));
    return r;
  } catch(e){ showToast('Erro: ' + e.message); return null; }
}

/* Normaliza a lista colada pelo usuário: aceita vírgula, ponto-e-vírgula,
   espaço ou quebra de linha, com ou sem o prefixo CASO-, e remove repetidos. */
function parseCacheIds(raw){
  const seen = new Set(), ids = [];
  for(const tok of String(raw || '').split(/[\s,;]+/)){
    const num = tok.replace(/^CASO-?/i, '').replace(/\D/g, '');
    if(!num) continue;
    const fid = 'CASO-' + num;
    if(seen.has(fid)) continue;
    seen.add(fid);
    ids.push(fid);
  }
  return ids;
}

/* Ação do card "Limpar cache de casos específicos" no Admin Mode. */
function clearCacheFromInput(){
  const inp = document.getElementById('cache-ids');
  const box = document.getElementById('cache-ids-result');
  const ids = parseCacheIds(inp.value);
  box.style.display = 'block';
  if(!ids.length){
    box.innerHTML = '<span style="color:var(--rtx)">Nenhum ID reconhecido. Informe os números dos casos.</span>';
    return;
  }
  if(ids.length > CACHE_IDS_MAX){
    box.innerHTML = `<span style="color:var(--rtx)">Máximo de ${CACHE_IDS_MAX} casos por vez (${ids.length} informados).</span>`;
    return;
  }
  showConfirm('Limpar cache destes casos',
    `As fotos de <b>${ids.length} caso(s)</b> serão lidas de novo no Google Drive na próxima abertura. Nenhum arquivo do Drive é apagado. Vale só para a base ativa.`,
    [{label:'Casos', val: ids.join(', ')}],
    async () => {
      const r = await clearCacheBatch(ids);
      if(!r){ box.innerHTML = '<span style="color:var(--rtx)">Falha na chamada ao servidor.</span>'; return; }
      if(!r.ok){ box.innerHTML = `<span style="color:var(--rtx)">${esc(apiErrText(r))}</span>`; return; }
      box.innerHTML = `<div style="color:var(--gtx);font-weight:600">✓ ${r.limpos.length} caso(s) limpo(s) · ${r.thumbs} thumb(s) removida(s)</div>`
        + (r.limpos.length ? `<div style="margin-top:.35rem;color:var(--tx2)">Limpos: ${esc(r.limpos.join(', '))}</div>` : '')
        + (r.sem_cache && r.sem_cache.length
            ? `<div style="margin-top:.35rem;color:var(--atx)">Já estavam sem cache: ${esc(r.sem_cache.join(', '))}</div>` : '');
      inp.value = '';
      if(typeof renderGrid === 'function') renderGrid();
    }
  );
}
