/* Constantes globais, helpers de string, cliente HTTP e UI primitives. */

const API = 'api/handler.php';

/* Token CSRF da sessão. Preenchido pela resposta de login/check_session e
   reenviado no cabeçalho X-CSRF-Token em toda requisição POST. */
let CSRF_TOKEN = '';

/* Identificador de build. Sirva-se dele para confirmar, depois de um deploy,
   que a versão nova realmente carregou no navegador. ATUALIZE este valor a
   cada alteração publicada. O index.php lê este mesmo texto do arquivo no
   servidor e o injeta em window.APP_BUILD_EXPECTED; se o que o navegador
   carregou divergir do que está no servidor, exibimos um aviso de cache. */
const APP_BUILD = 'v23.06 (2026-06-12)';

(function reportBuild(){
  try {
    console.log('%cBanco de Imagens — build ' + APP_BUILD,
      'color:#7c5cff;font-weight:700;font-size:12px');
    const badge = document.querySelector('.vbadge');
    if (badge) { badge.textContent = APP_BUILD.split(' ')[0]; badge.title = 'build ' + APP_BUILD; }
    const expected = window.APP_BUILD_EXPECTED;
    if (expected && expected !== APP_BUILD && document.body) {
      console.warn('Versão em cache — navegador:', APP_BUILD, '| servidor:', expected);
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b45309;color:#fff;font:600 13px/1.4 system-ui,sans-serif;padding:9px 14px;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35)';
      bar.innerHTML = '⚠️ Você está vendo uma versão em <b>cache</b>. Aperte <b>Ctrl+Shift+R</b> para carregar a atualização. <span style="opacity:.85">(navegador: ' + APP_BUILD + ' · servidor: ' + expected + ')</span>';
      document.body.appendChild(bar);
    }
  } catch (e) {}
})();

const ESTADOS = [
  {s:'AC',n:'Acre'},{s:'AL',n:'Alagoas'},{s:'AP',n:'Amapá'},{s:'AM',n:'Amazonas'},
  {s:'BA',n:'Bahia'},{s:'CE',n:'Ceará'},{s:'DF',n:'Distrito Federal'},{s:'ES',n:'Espírito Santo'},
  {s:'GO',n:'Goiás'},{s:'MA',n:'Maranhão'},{s:'MT',n:'Mato Grosso'},{s:'MS',n:'Mato Grosso do Sul'},
  {s:'MG',n:'Minas Gerais'},{s:'PA',n:'Pará'},{s:'PB',n:'Paraíba'},{s:'PR',n:'Paraná'},
  {s:'PE',n:'Pernambuco'},{s:'PI',n:'Piauí'},{s:'RJ',n:'Rio de Janeiro'},{s:'RN',n:'Rio Grande do Norte'},
  {s:'RS',n:'Rio Grande do Sul'},{s:'RO',n:'Rondônia'},{s:'RR',n:'Roraima'},{s:'SC',n:'Santa Catarina'},
  {s:'SP',n:'São Paulo'},{s:'SE',n:'Sergipe'},{s:'TO',n:'Tocantins'}
];

const norm = s => (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'');
const cap  = s => s ? s.charAt(0).toUpperCase()+s.slice(1).toLowerCase() : '';
/* Escapa para HTML. Inclui aspas duplas (&quot;) para que valores vindos da
   planilha (motivo de bloqueio, nomes, cidades) não consigam "escapar" de um
   atributo title="..."/style="..." e injetar outro atributo (XSS). A aspa
   simples NÃO é escapada de propósito: os handlers inline (onclick="fn('...')")
   já fazem o escape manual de ' para o contexto de string JS; escapá-la aqui
   quebraria esses handlers. */
const esc  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

async function api(action, data = {}, method = 'GET'){
  const resp = await fetch(`${API}?action=${action}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST'
      ? {'Content-Type':'application/x-www-form-urlencoded', 'X-CSRF-Token': CSRF_TOKEN}
      : {},
    body: method === 'POST' ? new URLSearchParams(data).toString() : undefined
  });
  if(resp.status === 401){
    const d = await resp.json().catch(()=>{});
    if(d?.expired || d?.error?.includes('expirada')){
      alert('Sessão expirada.');
      location.reload();
    }
    throw new Error(d?.error || 'Não autenticado');
  }
  /* Resposta que não é JSON significa que o PHP morreu antes de responder
     (crash, HTML de erro do servidor). O status HTTP vai na mensagem para
     dar um ponto de partida em vez de um erro genérico de parse. */
  let json;
  try { json = await resp.json(); }
  catch(e){ throw new Error(`Resposta não-JSON do servidor (HTTP ${resp.status}) — possível crash no PHP. Abra o Diagnóstico do Admin.`); }
  if(json && json.csrf) CSRF_TOKEN = json.csrf;
  return json;
}

/* Texto de erro de uma resposta da API: mensagem + tipo e origem (arquivo:linha)
   quando o backend os informa — todo ponto que exibe erro deve usar isto. */
function apiErrText(r){
  if(!r) return 'sem resposta';
  let t = r.error || 'erro não informado';
  if(r.error_tipo) t += ` [${r.error_tipo}${r.error_origem ? ' em ' + r.error_origem : ''}]`;
  return t;
}

/* Lista de cidades (em MAIÚSCULAS) de uma UF. Fonte primária: o próprio backend,
   que lê o CSV oficial já presente no servidor — funciona mesmo sem internet ou
   atrás de firewall corporativo. Só recorre ao IBGE como último recurso. */
async function fetchCities(uf){
  try{
    const r = await api(`list_cities&uf=${encodeURIComponent(uf)}`);
    if(r && r.ok && Array.isArray(r.cities) && r.cities.length) return r.cities;
  } catch(e){}
  try{
    const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${encodeURIComponent(uf)}/municipios?orderBy=nome`);
    const d = await r.json();
    return d.map(x => x.nome.toUpperCase());
  } catch(e){ return []; }
}

/* showToast(msg) — string simples, 3 s
   showToast(msg, { undoLabel, onUndo }) — com botão desfazer, 8 s */
function showToast(msg, opts = {}){
  const t = document.getElementById('toast');
  clearTimeout(t._tid);
  const duration = opts.onUndo ? 8000 : 3000;
  if(opts.onUndo){
    t.innerHTML = `<span class="s-toast-msg">${esc(String(msg))}</span>
      <button class="s-toast-undo" onclick="_toastUndo()">${esc(opts.undoLabel || 'Desfazer')}</button>
      <div class="s-toast-bar"></div>`;
    t._onUndo = opts.onUndo;
    const bar = t.querySelector('.s-toast-bar');
    if(bar){
      bar.style.transition = 'none';
      bar.style.width = '100%';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        bar.style.transition = `width ${duration}ms linear`;
        bar.style.width = '0%';
      }));
    }
  } else {
    t.innerHTML = `<span class="s-toast-msg">${esc(String(msg))}</span>`;
    t._onUndo = null;
  }
  t.classList.add('show');
  t._tid = setTimeout(() => { t.classList.remove('show'); t._onUndo = null; }, duration);
}

function _toastUndo(){
  const t = document.getElementById('toast');
  clearTimeout(t._tid);
  t.classList.remove('show');
  const fn = t._onUndo;
  t._onUndo = null;
  if(fn) fn();
}

function showConfirm(title, desc, changes, onOk){
  const modal     = document.getElementById('confirm-modal');
  const titleEl   = document.getElementById('confirm-title');
  const descEl    = document.getElementById('confirm-desc');
  const changesEl = document.getElementById('confirm-changes');
  const okBtn     = document.getElementById('confirm-ok-btn');
  // Se algum elemento do modal não existir no HTML, falha de forma explícita
  // (com o nome do que faltou) em vez de deixar a tela travada só no overlay.
  const missing = [];
  if(!modal)     missing.push('#confirm-modal');
  if(!titleEl)   missing.push('#confirm-title');
  if(!descEl)    missing.push('#confirm-desc');
  if(!changesEl) missing.push('#confirm-changes');
  if(!okBtn)     missing.push('#confirm-ok-btn');
  if(missing.length) throw new Error('Modal de confirmação incompleto no HTML — faltando: ' + missing.join(', '));

  titleEl.textContent = title;
  descEl.innerHTML = desc;
  changesEl.innerHTML = changes.map(c =>
    `<div class="confirm-row"><div class="confirm-label">${esc(c.label)}</div><div class="confirm-val">${esc(c.val)}</div></div>`
  ).join('');
  okBtn.disabled = false;
  okBtn.textContent = 'Confirmar';
  // Mantém o modal aberto com feedback de carregamento enquanto a ação roda;
  // desabilita o botão para impedir clique duplo e só fecha ao concluir.
  okBtn.onclick = async () => {
    okBtn.disabled = true;
    okBtn.innerHTML = '<span class="spin"></span> Processando...';
    try {
      await onOk();
    } finally {
      modal.classList.remove('open');
      okBtn.disabled = false;
      okBtn.textContent = 'Confirmar';
    }
  };
  modal.classList.add('open');
}

function renderDD(id, list, q, onSelect){
  const dd = document.getElementById(id);
  const fl = q ? list.filter(c => norm(c).includes(norm(q))) : list;
  if(!fl.length){ dd.classList.remove('open'); return; }
  dd.innerHTML = '';
  fl.slice(0, 50).forEach(c => {
    const d = document.createElement('div');
    d.className = 'do';
    d.textContent = cap(c);
    d.addEventListener('click', () => onSelect(c));
    dd.appendChild(d);
  });
  dd.classList.add('open');
}

function renderFormDD(id, list, q, onSelect){
  const dd = document.getElementById(id);
  const fl = q ? list.filter(c => norm(c).includes(norm(q))) : list;
  if(!fl.length){ dd.classList.remove('open'); return; }
  dd.innerHTML = '';
  fl.slice(0, 50).forEach(c => {
    const div = document.createElement('div');
    div.className = 'do';
    div.textContent = cap(c);
    div.addEventListener('click', () => onSelect(c));
    dd.appendChild(div);
  });
  dd.classList.add('open');
}

/* Distância de Levenshtein — usada para sugestões "Você quis dizer?" em autocomplete. */
function lev(a, b){
  const m = a.length, n = b.length;
  const d = Array.from({length:m+1}, (_,i) => Array.from({length:n+1}, (_,j) => i ? (j ? 0 : j) : i));
  for(let i = 1; i <= m; i++)
    for(let j = 1; j <= n; j++)
      d[i][j] = a[i-1] === b[j-1] ? d[i-1][j-1] : 1 + Math.min(d[i-1][j], d[i][j-1], d[i-1][j-1]);
  return d[m][n];
}

function populateEstados(){
  ['fuf','auf','bauf','biuf'].forEach(id => {
    const el = document.getElementById(id);
    if(!el || el.tagName !== 'SELECT') return;
    el.innerHTML = id === 'fuf' ? '<option value="">Todos os estados</option>' : '<option value="">Selecione...</option>';
    ESTADOS.forEach(e => el.appendChild(new Option(`${e.s} – ${e.n}`, e.s)));
  });
}

function togglePwd(){
  const inp = document.getElementById('lp'), btn = document.getElementById('lpbtn');
  const show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
}

function buildProfAC(inp, ddId, sugId){
  const q = document.getElementById(inp).value.trim();
  const qn = norm(q);
  const sugEl = document.getElementById(sugId);
  if(!q){
    document.getElementById(ddId).classList.remove('open');
    sugEl.style.display = 'none';
    return;
  }
  const starts = allProfs.filter(p => norm(p).startsWith(qn));
  renderFormDD(ddId, starts, '', c => {
    document.getElementById(inp).value = c;
    document.getElementById(ddId).classList.remove('open');
    sugEl.style.display = 'none';
  });
  const sug = allProfs.find(p => norm(p) !== qn && lev(norm(p), qn) <= 3);
  if(sug && !starts.length){
    sugEl.style.display = 'block';
    sugEl.innerHTML = `Você quis dizer <b>${esc(sug)}</b>?<div class="sbtn">
      <button class="btn bp" style="padding:4px 12px;font-size:12px" onclick="document.getElementById('${inp}').value='${sug.replace(/'/g,"\\'")}';document.getElementById('${sugId}').style.display='none'">Sim</button>
      <button class="btn bs" style="padding:4px 12px;font-size:12px" onclick="document.getElementById('${sugId}').style.display='none'">Manter</button>
    </div>`;
  } else {
    sugEl.style.display = 'none';
  }
}
