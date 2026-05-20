/* Constantes globais, helpers de string, cliente HTTP e UI primitives. */

const API = 'api/handler.php';

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
const esc  = s => (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

async function api(action, data = {}, method = 'GET'){
  const resp = await fetch(`${API}?action=${action}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'POST' ? {'Content-Type':'application/x-www-form-urlencoded'} : {},
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
  return resp.json();
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
  document.getElementById('confirm-title').textContent = title;
  document.getElementById('confirm-desc').innerHTML = desc;
  document.getElementById('confirm-changes').innerHTML = changes.map(c =>
    `<div class="confirm-row"><div class="confirm-label">${esc(c.label)}</div><div class="confirm-val">${esc(c.val)}</div></div>`
  ).join('');
  document.getElementById('confirm-ok-btn').onclick = () => {
    document.getElementById('confirm-modal').classList.remove('open');
    onOk();
  };
  document.getElementById('confirm-modal').classList.add('open');
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
