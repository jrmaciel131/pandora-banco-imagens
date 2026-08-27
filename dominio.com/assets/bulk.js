/* Operações em lote (registro em massa, por ID, download ZIP) e lightbox flutuante. */

let selMode = false, selIds = new Set(), bulkSelIds = new Set();
let bulkCities = {ba:[], bi:[]};
/* Locais já adicionados em cada modal de registro em massa ('ba' = grade,
   'bi' = por ID). Um profissional costuma atuar em mais de uma cidade/estado
   (ex.: Fortaleza-CE e Parnaíba-PI), e cada caso selecionado recebe todas as
   linhas da lista de uma vez. */
let bulkPending = {ba:[], bi:[]};
let _lfIdx = 0, _lfLoadToken = 0;

function openLightboxFlo(idx){
  if(!currentPhotos || !currentPhotos.length) return;
  _lfIdx = Math.max(0, Math.min(idx, currentPhotos.length - 1));
  renderLightboxFlo();
  document.getElementById('lightbox-flo').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightboxFlo(){
  document.getElementById('lightbox-flo').classList.remove('open');
  document.body.style.overflow = '';
}

function lightboxFloNav(dir){
  if(!currentPhotos || !currentPhotos.length) return;
  _lfIdx = (_lfIdx + dir + currentPhotos.length) % currentPhotos.length;
  renderLightboxFlo();
}

/* URL da rendição grande (~1600px). Quando o servidor já materializou o
   arquivo, preview_url aponta pro estático; senão a action view_preview gera
   e guarda em cache na primeira visita. Bem mais leve que o original — o
   download em qualidade total continua nos botões Drive/Baixar. */
function previewSrc(p){
  return p.preview_url || `${API}?action=view_preview&file_id=${encodeURIComponent(p.id)}`;
}

function prefetchPreview(idx){
  const p = currentPhotos[idx];
  if(!p || !p.id) return;
  new Image().src = previewSrc(p);
}

function renderLightboxFlo(){
  const p = currentPhotos[_lfIdx];
  if(!p) return;
  const img = document.getElementById('lf-img');
  const info = document.getElementById('lf-info');
  img.alt = p.name || '';
  /* Marca a navegação atual para descartar carregamentos de imagens já trocadas. */
  const token = ++_lfLoadToken;
  /* Mostra a thumbnail imediatamente e troca pela rendição grande quando
     pronta. Para vídeos a rendição é o frame de capa gerado pelo Drive. */
  img.src = p.thumb_url || '';
  img.classList.remove('lf-loading');
  if(p.id){
    img.classList.add('lf-loading');
    const full = new Image();
    full.onload = () => {
      if(token !== _lfLoadToken) return;
      img.src = full.src;
      img.classList.remove('lf-loading');
    };
    full.onerror = () => { if(token === _lfLoadToken) img.classList.remove('lf-loading'); };
    full.src = previewSrc(p);
  }
  const tag = p.version_tag ? ` · ${p.version_tag}` : '';
  info.textContent = `${p.name || ''} (${_lfIdx+1}/${currentPhotos.length})${tag}`;
  document.getElementById('lf-prev').disabled = currentPhotos.length <= 1;
  document.getElementById('lf-next').disabled = currentPhotos.length <= 1;
  /* Pré-carrega os vizinhos para navegação instantânea com ←/→. */
  if(currentPhotos.length > 1){
    prefetchPreview((_lfIdx + 1) % currentPhotos.length);
    prefetchPreview((_lfIdx - 1 + currentPhotos.length) % currentPhotos.length);
  }
}

/* Abre o visualizador em tela cheia direto do card da grade (botão olho),
   sem passar pelo painel do caso. A thumb da grade entra como placeholder
   enquanto a lista de fotos do caso é buscada. */
async function openCaseViewer(id, e){
  if(e) e.stopPropagation();
  const lf = document.getElementById('lightbox-flo');
  const img = document.getElementById('lf-img');
  const info = document.getElementById('lf-info');
  currentPhotos = [];
  _lfIdx = 0;
  const token = ++_lfLoadToken;
  const tc = typeof thumbCache !== 'undefined' ? thumbCache[id] : null;
  img.src = (tc && tc.url) || '';
  img.alt = id;
  img.classList.add('lf-loading');
  info.textContent = `${id} — carregando...`;
  document.getElementById('lf-prev').disabled = true;
  document.getElementById('lf-next').disabled = true;
  lf.classList.add('open');
  document.body.style.overflow = 'hidden';
  try{
    const r = await api(`photos&id=${encodeURIComponent(id)}`);
    if(token !== _lfLoadToken || !lf.classList.contains('open')) return;
    if(!r.photos?.length){
      img.classList.remove('lf-loading');
      info.textContent = `${id} — nenhuma foto/vídeo no Drive`;
      return;
    }
    currentPhotos = r.photos;
    renderLightboxFlo();
  } catch(err){
    if(token !== _lfLoadToken) return;
    img.classList.remove('lf-loading');
    info.textContent = `${id} — erro ao buscar fotos`;
  }
}

function lightboxFloCloud(){
  const p = currentPhotos[_lfIdx];
  if(p && p.webViewLink) window.open(p.webViewLink, '_blank');
}

function lightboxFloDownload(){
  const p = currentPhotos[_lfIdx];
  if(p) downloadSingleFile(p.id, p.name);
}

document.addEventListener('keydown', e => {
  const lf = document.getElementById('lightbox-flo');
  if(!lf || !lf.classList.contains('open')) return;
  if(e.key === 'Escape'){ e.preventDefault(); closeLightboxFlo(); }
  else if(e.key === 'ArrowLeft'){ e.preventDefault(); lightboxFloNav(-1); }
  else if(e.key === 'ArrowRight'){ e.preventDefault(); lightboxFloNav(1); }
});

async function downloadSingleFile(fileId, filename, btn){
  if(!fileId) return;
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span>'; }
  try{
    /* Backend autenticado intermedia o download direto do Drive. */
    const url = `${API}?action=download_photo&file_id=${encodeURIComponent(fileId)}`;
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'arquivo';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Download iniciado...');
  } catch(e){ showToast('Erro ao baixar.'); }
  if(btn){ setTimeout(() => { btn.disabled = false; btn.innerHTML = '⬇ Baixar'; }, 1500); }
}

function toggleSelAll(){
  const allIds = filtered.map(c => c.id);
  const allSel = allIds.every(id => selIds.has(id));
  if(allSel) allIds.forEach(id => selIds.delete(id));
  else { allIds.forEach(id => selIds.add(id)); selMode = true; }
  if(!selIds.size) selMode = false;
  updateBulkBar();
  renderGrid();
  document.getElementById('btn-selall').textContent = selIds.size > 0 ? 'Desmarcar' : 'Todos';
}

function toggleSel(){
  selMode = !selMode;
  if(!selMode) clearSel();
  else updateBulkBar();
  renderGrid();
  document.getElementById('btn-sel').textContent = selMode ? 'Cancelar' : 'Selecionar';
}

function toggleCardSel(id, e){
  e.stopPropagation();
  if(selIds.has(id)) selIds.delete(id);
  else selIds.add(id);
  const c = document.getElementById('card-'+id);
  if(c){
    c.classList.toggle('sel', selIds.has(id));
    const s = c.querySelector('.csel');
    if(s) s.textContent = selIds.has(id) ? '✓' : '';
  }
  updateBulkBar();
}

function clearSel(){
  selIds.clear();
  selMode = false;
  updateBulkBar();
  renderGrid();
  document.getElementById('btn-sel').textContent = 'Selecionar';
  document.getElementById('btn-selall').textContent = 'Todos';
}

function updateBulkBar(){
  const n = selIds.size, bar = document.getElementById('bb');
  if(n > 0 && selMode){
    bar.classList.add('show');
    document.getElementById('bc').textContent = `${n} caso${n>1?'s':''} selecionado${n>1?'s':''}`;
  } else bar.classList.remove('show');
}

/* Download em lote: backend monta o ZIP com PHP ZipArchive e stream — sem lib JS.
   Como é uma única resposta (sem progresso real), mostramos um overlay com
   cronômetro pra deixar claro que está trabalhando — vídeos podem demorar. */
async function downloadBulkZip(){
  if(!selIds.size){ showToast('Selecione pelo menos 1 caso.'); return; }
  if(selIds.size > 30){ showToast(`Máximo 30 casos por download. Selecionados: ${selIds.size}.`); return; }
  const ids = [...selIds].join(',');
  const count = selIds.size;

  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:950;display:flex;align-items:center;justify-content:center;padding:1rem';
  ov.innerHTML = `<div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:2rem 2.5rem;text-align:center;min-width:260px;box-shadow:var(--shadow-lg)">
    <span class="spin" style="width:30px;height:30px;border-width:3px"></span>
    <div style="margin-top:.85rem;font-size:14px;font-weight:600">Gerando ZIP de ${count} caso(s)…</div>
    <div style="margin-top:.35rem;font-size:12px;color:var(--tx2)" id="zip-timer">Preparando… vídeos podem demorar</div>
  </div>`;
  document.body.appendChild(ov);
  let secs = 0;
  const timer = setInterval(() => {
    secs++;
    const t = document.getElementById('zip-timer');
    if(t) t.textContent = `${secs}s — baixando e compactando (limite: 2 GB / 30 casos)`;
  }, 1000);

  try{
    const resp = await fetch(`${API}?action=download_bulk`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type':'application/x-www-form-urlencoded', 'X-CSRF-Token': CSRF_TOKEN},
      body: new URLSearchParams({ids}).toString()
    });
    const ct = resp.headers.get('Content-Type') || '';
    if(!resp.ok || !ct.includes('zip')){
      let msg = 'Falha ao gerar ZIP.';
      try { const j = await resp.json(); if(j.error) msg = j.error; } catch(e){}
      showToast('Erro: '+msg);
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const cd = resp.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/);
    const filename = m ? m[1] : `casos_${count}.zip`;
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    showToast(`✅ ZIP com ${count} caso(s) baixado.`);
  } catch(e){ showToast('Erro de conexão: '+e.message); }
  finally { clearInterval(timer); ov.remove(); }
}

/* ── Registro em massa: vários locais por profissional ────────
   Os dois modais (grade e por ID) compartilham a mesma mecânica: o usuário
   monta uma lista de locais (UF + cidade + profissional) e todos os casos
   selecionados recebem a lista inteira numa única gravação por caso. */

function bulkFieldIds(t){
  return t === 'ba'
    ? {uf:'bauf', city:'baci', prof:'bapro', sug:'baprosug', err:'baerr',  errs:'baerrs', list:'ba-pending', btn:'babtn', ov:'bav'}
    : {uf:'biuf', city:'bici', prof:'bipro', sug:'biprosug', err:'bierr2', errs:'bierrs', list:'bi-pending', btn:'bibtn', ov:'biv'};
}

/* O registro substitui o conteúdo do modal pela tela de progresso e depois
   pela de resultado. Guardamos o formulário original na primeira abertura e
   o restauramos nas seguintes, em vez de exigir um reload da página. */
const _bulkModalHtml = {};
function resetBulkModal(t){
  const modal = document.querySelector(`#${bulkFieldIds(t).ov} .modal`);
  if(!modal) return;
  if(_bulkModalHtml[t] === undefined) _bulkModalHtml[t] = modal.innerHTML;
  else modal.innerHTML = _bulkModalHtml[t];
}

/* Zera o formulário e a lista de locais de um dos modais. */
function resetBulkForm(t){
  const f = bulkFieldIds(t);
  bulkPending[t] = [];
  bulkCities[t] = [];
  const uf = document.getElementById(f.uf);
  uf.innerHTML = '<option value="">Selecione...</option>';
  ESTADOS.forEach(e => uf.appendChild(new Option(`${e.s} – ${e.n}`, e.s)));
  const ci = document.getElementById(f.city);
  ci.value = ''; ci.dataset.val = ''; ci.readOnly = true;
  ci.placeholder = 'Selecione estado...';
  document.getElementById(f.prof).value = '';
  document.getElementById(f.sug).style.display = 'none';
  document.getElementById(f.errs).style.display = 'none';
  document.getElementById(f.err).textContent = '';
  renderBulkPending(t);
}

function currentBulkRow(t){
  const f = bulkFieldIds(t);
  return {
    uf: document.getElementById(f.uf).value,
    cidade: (document.getElementById(f.city).dataset.val || '').toUpperCase(),
    profissional: document.getElementById(f.prof).value.trim(),
  };
}

/* Guarda a linha atual na lista. Mantém estado e profissional preenchidos
   (o fluxo comum é o mesmo profissional atuando em outra cidade) e limpa só
   a cidade. Para mudar de estado basta trocar o select. */
function addBulkPending(t){
  const f = bulkFieldIds(t);
  const err = document.getElementById(f.err);
  err.textContent = '';
  const row = currentBulkRow(t);
  if(!row.uf || !row.cidade || !row.profissional){
    err.textContent = 'Preencha estado, cidade e profissional antes de adicionar.';
    return;
  }
  if(bulkPending[t].some(p => p.cidade === row.cidade)){
    err.textContent = `Cidade ${cap(row.cidade)} já está na lista.`;
    return;
  }
  bulkPending[t].push(row);
  const ci = document.getElementById(f.city);
  ci.value = ''; ci.dataset.val = '';
  document.getElementById(f.sug).style.display = 'none';
  renderBulkPending(t);
}

function removeBulkPending(t, i){
  bulkPending[t].splice(i, 1);
  renderBulkPending(t);
}

function renderBulkPending(t){
  const f = bulkFieldIds(t);
  const box = document.getElementById(f.list);
  if(box){
    const list = bulkPending[t];
    if(!list.length){ box.innerHTML = ''; box.style.display = 'none'; }
    else {
      box.style.display = 'block';
      box.innerHTML = `<div style="font-size:10px;color:var(--tx2);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px">Locais adicionados (${list.length})</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px">${list.map((p, i) =>
          `<span class="tag-pill" style="font-size:12px;background:var(--gbg);color:var(--gtx)">${esc(p.uf)} / ${esc(cap(p.cidade))} / ${esc(p.profissional)}<span class="x" onclick="removeBulkPending('${t}',${i})" title="Remover este local">×</span></span>`
        ).join('')}</div>`;
    }
  }
  updateBulkBtnLabel(t);
}

function updateBulkBtnLabel(t){
  const btn = document.getElementById(bulkFieldIds(t).btn);
  if(!btn) return;
  const row = currentBulkRow(t);
  let n = bulkPending[t].length;
  if(row.uf && row.cidade && row.profissional) n++;
  btn.textContent = n > 1 ? `Registrar ${n} locais em todos` : 'Registrar em todos';
}

/* Linhas efetivas: as já adicionadas mais a linha do formulário, quando
   preenchida. Devolve {entries} ou {error}. A cidade é o que define se há uma
   linha nova: depois de "Adicionar outro local" o estado e o profissional
   continuam preenchidos de propósito, e sozinhos não formam um local. */
function collectBulkEntries(t){
  const f = bulkFieldIds(t);
  const row = currentBulkRow(t);
  const entries = bulkPending[t].slice();
  const cidadeDigitada = document.getElementById(f.city).value.trim();
  if(cidadeDigitada && !row.cidade)
    return {error: 'Escolha a cidade na lista que aparece abaixo do campo.'};
  if(row.cidade){
    if(!row.uf || !row.profissional)
      return {error: 'Linha atual incompleta: preencha estado, cidade e profissional.'};
    if(entries.some(p => p.cidade === row.cidade))
      return {error: `Cidade ${cap(row.cidade)} já está na lista.`};
    entries.push(row);
  }
  if(!entries.length) return {error: 'Preencha todos os campos.'};
  return {entries};
}

function openBulkApply(){
  if(!selIds.size) return;
  resetBulkModal('ba');
  document.getElementById('bai').textContent = `Aplicar para ${selIds.size} caso(s): ${[...selIds].join(', ')}`;
  resetBulkForm('ba');
  document.getElementById('bav').classList.add('open');
}

/* Núcleo dos dois registros em massa. Aplica a mesma lista de locais a todos
   os casos selecionados: uma chamada add_uso_batch por caso, ou seja, uma
   gravação por caso mesmo quando há vários locais. */
async function runBulkRegister(t){
  const f      = bulkFieldIds(t);
  const errEl  = document.getElementById(f.err);
  const errsEl = document.getElementById(f.errs);
  const ids    = t === 'ba' ? [...selIds] : [...bulkSelIds];
  errEl.textContent = '';
  errsEl.style.display = 'none';

  if(!ids.length){ errEl.textContent = 'Nenhum caso selecionado.'; return; }
  const col = collectBulkEntries(t);
  if(col.error){ errEl.textContent = col.error; return; }
  const entries = col.entries;
  const total = ids.length;
  const payload = JSON.stringify(entries);

  /* Pré-flight ATÔMICO via backend (cidade em uso, bloqueio e distância),
     considerando também as demais linhas do próprio lote. */
  const pre = await api('bulk_preflight', {ids:ids.join(','), entries:payload}, 'POST');
  if(!pre.ok){ errEl.textContent = apiErrText(pre); return; }
  if(pre.errors && pre.errors.length){
    errsEl.innerHTML = `<div style="font-weight:700;margin-bottom:.4rem">Falhou na verificação prévia (${pre.errors.length}), nada foi gravado:</div>`
      + pre.errors.map(e => `<div style="padding:2px 0">• ${esc(e)}</div>`).join('');
    errsEl.style.display = 'block';
    return;
  }
  if(pre.warns && pre.warns.length){
    /* Com vários locais × vários casos a lista de avisos cresce rápido; o
       alerta mostra os primeiros e resume o resto. */
    const shown = pre.warns.slice(0, 15);
    const rest  = pre.warns.length - shown.length;
    const proceed = confirm(`Atenção (${pre.warns.length} aviso(s)):\n\n${shown.join('\n')}${rest > 0 ? `\n… e mais ${rest}.` : ''}\n\nDeseja continuar mesmo assim?`);
    if(!proceed) return;
  }

  const modal = document.querySelector(`#${f.ov} .modal`);
  const alvo = entries.length > 1 ? `${entries.length} locais em ${total} caso(s)` : `${total} caso(s)`;
  modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
    <div style="margin-bottom:1.25rem"><span class="spin" style="width:32px;height:32px;border-width:3px"></span></div>
    <div style="font-size:15px;font-weight:600;margin-bottom:.5rem">Registrando ${esc(alvo)}...</div>
    <div style="font-size:13px;color:var(--tx2);margin-bottom:.5rem" id="bulk-progress">0 de ${total} processados</div>
    <div style="width:100%;max-width:240px;margin:0 auto;height:4px;background:var(--bd);border-radius:2px;overflow:hidden">
      <div id="bulk-bar" style="height:100%;background:var(--accent);width:0%;transition:width .2s;border-radius:2px"></div>
    </div>
  </div>`;

  /* Busca dentro do modal: os dois usam os mesmos ids e um pode ter ficado
     com a tela de progresso anterior na tela. */
  const prog = modal.querySelector('#bulk-progress');
  const bar  = modal.querySelector('#bulk-bar');
  const errors = [];
  let done = 0;
  for(const id of ids){
    const caso = casos.find(c => c.id === id);
    if(!caso) errors.push(`${id}: não encontrado na planilha`);
    else {
      try{
        const r = await api('add_uso_batch', {caso_id:id, row:caso.row, entries:payload, force:'1'}, 'POST');
        if(!r.ok){
          const det = Array.isArray(r.errors) && r.errors.length ? r.errors.join(' ') : apiErrText(r);
          errors.push(`${id}: ${det}`);
        }
      } catch(e){ errors.push(`${id}: falha de conexão`); }
    }
    done++;
    if(prog) prog.textContent = `${done} de ${total} processados`;
    if(bar)  bar.style.width = `${Math.round(done/total*100)}%`;
  }

  await loadCasos(true);
  const ok = total - errors.length;
  const locais = entries.map(p =>
    `<div style="font-size:13px;color:var(--tx2);margin-bottom:.25rem"><b>${esc(p.uf)} / ${esc(cap(p.cidade))}</b>: ${esc(p.profissional)}</div>`
  ).join('');
  const fechar = t === 'ba'
    ? `document.getElementById('bav').classList.remove('open');clearSel()`
    : `document.getElementById('biv').classList.remove('open')`;

  if(errors.length){
    modal.innerHTML = `<div style="padding:2rem 1.5rem">
      <div style="font-size:2rem;text-align:center;margin-bottom:.75rem">${ok>0?'⚠️':'❌'}</div>
      <div style="font-size:15px;font-weight:700;text-align:center;margin-bottom:1rem;color:${ok>0?'var(--atx)':'var(--rtx)'}">
        ${ok>0?`${ok} registrados, ${errors.length} com erro`:'Falha ao registrar'}
      </div>
      ${ok>0?`<div style="text-align:center;margin-bottom:.75rem">${locais}</div>`:''}
      <div style="background:var(--rbg);border:1px solid var(--rtx);border-radius:var(--rs);padding:.75rem;font-size:12px;color:var(--rtx);max-height:180px;overflow-y:auto;margin-bottom:1rem">
        <div style="font-weight:700;margin-bottom:.4rem">Erros (${errors.length}):</div>
        ${errors.map(e => `<div style="padding:2px 0">• ${esc(e)}</div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn bp" onclick="${fechar}">Fechar</button>
        <button class="btn bs" onclick="document.getElementById('${f.ov}').classList.remove('open')">Manter seleção</button>
      </div>
    </div>`;
  } else {
    modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
      <div style="font-size:16px;font-weight:700;color:var(--gtx);margin-bottom:.75rem">${ok} caso(s) registrados com sucesso!</div>
      <div style="margin-bottom:1.25rem">${locais}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-bottom:1.5rem;max-height:120px;overflow-y:auto">
        ${ids.map(id => `<span style="padding:2px 8px;background:var(--gbg);color:var(--gtx);border-radius:10px;font-size:11px">${esc(id)}</span>`).join('')}
      </div>
      <button class="btn bp" onclick="${fechar}" style="margin:0 auto">Concluir</button>
    </div>`;
    bulkPending[t] = [];
    if(t === 'bi') bulkSelIds = new Set();
  }
}

function openBulkModal(){
  resetBulkModal('bi');
  document.getElementById('biinp').value = '';
  document.getElementById('bierr').textContent = '';
  document.getElementById('bigrid').innerHTML = '';
  document.getElementById('biform').style.display = 'none';
  resetBulkForm('bi');
  bulkSelIds = new Set();
  document.getElementById('biv').classList.add('open');
}

function parseBulkIds(){
  const raw = document.getElementById('biinp').value;
  const err = document.getElementById('bierr');
  err.style.color = '';
  err.textContent = '';
  const tokens = raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean);
  if(!tokens.length){ err.textContent = 'Digite ao menos um ID.'; return; }

  /* Dedup de IDs duplicados no input. IDs repetidos são ignorados silenciosamente
     com um aviso temporário pra orientar o usuário. */
  const seen = new Set();
  const ids = [];
  let dupCount = 0;
  for(const t of tokens){
    const clean = t.replace(/^CASO-?/i,'').replace(/\D/g,'');
    if(!clean) continue;
    const fid = `CASO-${clean}`;
    if(seen.has(fid)){ dupCount++; continue; }
    seen.add(fid);
    ids.push(fid);
  }
  if(dupCount > 0){
    err.style.color = 'var(--atx)';
    err.textContent = `${dupCount} ID(s) repetido(s) foram ignorado(s).`;
    setTimeout(() => { err.textContent = ''; err.style.color = ''; }, 4000);
  }

  const grid = document.getElementById('bigrid');
  grid.innerHTML = '';
  bulkSelIds = new Set();
  let found = 0;

  ids.forEach(fid => {
    const ex = casos.some(c => c.id === fid);
    if(ex) bulkSelIds.add(fid);
    const wrap = document.createElement('div'); wrap.className = 'icw';
    const chip = document.createElement('div'); chip.className = `ic ${ex?'sel':'inv'}`; chip.textContent = fid;

    const pop = document.createElement('div'); pop.className = 'icpop';
    if(ex){
      if(thumbCache[fid]?.url) pop.innerHTML = `<img src="${thumbCache[fid].url}">`;
      chip.addEventListener('mouseenter', async () => {
        if(!thumbCache[fid]?.url){
          try{
            const r = await api(`photos&id=${encodeURIComponent(fid)}`);
            const p = r.photos?.find(x => x.thumb_url);
            if(p){
              thumbCache[fid] = {url:p.thumb_url, isVideo:p.isVideo};
              pop.innerHTML = `<img src="${p.thumb_url}">`;
            }
          } catch(e){}
        } else {
          pop.innerHTML = `<img src="${thumbCache[fid].url}">`;
        }
        /* Tenta posicionar o popup acima do chip; cai pra baixo se faltar espaço. */
        const POP = 240, GAP = 10;
        const rect = chip.getBoundingClientRect();
        let left = rect.left + rect.width/2 - POP/2;
        let top = rect.top - POP - GAP;
        left = Math.max(8, Math.min(left, window.innerWidth - POP - 8));
        if(top < 8) top = Math.min(rect.bottom + GAP, window.innerHeight - POP - 8);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
        pop.classList.add('show');
      });
      chip.addEventListener('mouseleave', () => pop.classList.remove('show'));
      chip.addEventListener('click', () => {
        if(bulkSelIds.has(fid)){ bulkSelIds.delete(fid); chip.classList.remove('sel'); chip.classList.add('inv'); }
        else                    { bulkSelIds.add(fid);    chip.classList.add('sel');    chip.classList.remove('inv'); }
        const cnt = [...bulkSelIds].length;
        document.getElementById('biform').style.display = cnt > 0 ? 'block' : 'none';
        document.getElementById('biform-t').textContent = `Aplicar para ${cnt} caso(s)`;
      });
      found++;
    }
    wrap.appendChild(chip);
    document.body.appendChild(pop);
    wrap.addEventListener('mouseleave', () => pop.classList.remove('show'));
    grid.appendChild(wrap);
  });

  if(!found){ err.textContent = 'Nenhum ID encontrado.'; document.getElementById('biform').style.display = 'none'; return; }
  document.getElementById('biform').style.display = 'block';
  document.getElementById('biform-t').textContent = `Aplicar para ${found} caso(s)`;
}

async function onBulkUF(t){
  const si = t === 'ba' ? 'bauf' : 'biuf';
  const ci = t === 'ba' ? 'baci' : 'bici';
  const uf = document.getElementById(si).value;
  const el = document.getElementById(ci);
  el.value = ''; el.dataset.val = '';
  bulkCities[t] = [];
  el.readOnly = true;
  updateBulkBtnLabel(t);
  if(uf){
    el.placeholder = 'Carregando...';
    await loadIBGE(uf, t);
    el.readOnly = false;
    el.placeholder = 'Pesquise a cidade...';
  }
}

function onBulkCityInp(t){
  const ci = t === 'ba' ? 'baci' : 'bici';
  const dd = t === 'ba' ? 'bacdd' : 'bicdd';
  renderFormDD(dd, bulkCities[t], document.getElementById(ci).value, c => {
    const e = document.getElementById(ci);
    e.value = cap(c); e.dataset.val = c;
    document.getElementById(dd).classList.remove('open');
    updateBulkBtnLabel(t);
  });
}

function openBulkCityDD(t){
  const ci = t === 'ba' ? 'baci' : 'bici';
  if(!document.getElementById(ci).readOnly) onBulkCityInp(t);
}

function onBulkProf(t){
  if(t === 'ba') buildProfAC('bapro', 'baprodd', 'baprosug');
  else           buildProfAC('bipro', 'biprodd', 'biprosug');
  updateBulkBtnLabel(t);
}

/* ── Aplicar tag em massa ─────────────────────────────────── */
function openBulkTag(){
  if(!selIds.size){ showToast('Selecione ao menos 1 caso.'); return; }
  const info = document.getElementById('bt-info');
  if(info) info.textContent = `Aplicar tag em ${selIds.size} caso(s) selecionado(s).`;
  const inp = document.getElementById('bt-inp');
  if(inp){ inp.value = ''; }
  const dd = document.getElementById('bt-dd');
  if(dd){ dd.innerHTML = ''; dd.classList.remove('open'); }
  const errEl = document.getElementById('bt-err');
  if(errEl) errEl.textContent = '';
  document.getElementById('btv').classList.add('open');
  /* Pré-popula lista de tags canônicas */
  onBulkTagInput();
}

function onBulkTagInput(){
  const inp = document.getElementById('bt-inp');
  const dd  = document.getElementById('bt-dd');
  if(!inp || !dd) return;
  const q = inp.value.trim().toUpperCase();
  const list = typeof canonicalTags !== 'undefined' ? canonicalTags : [];
  const matches = list.filter(t => !q || t.includes(q));
  dd.innerHTML = matches.slice(0, 30).map(t =>
    `<div class="ddi" onclick="document.getElementById('bt-inp').value='${esc(t)}';document.getElementById('bt-dd').classList.remove('open')">${esc(t)}</div>`
  ).join('') || `<div class="ddi" style="color:var(--tx3);pointer-events:none">Nenhuma tag encontrada</div>`;
  dd.classList.toggle('open', matches.length > 0 || q.length > 0);
}

async function submitBulkTag(){
  const inp   = document.getElementById('bt-inp');
  const errEl = document.getElementById('bt-err');
  const tag   = inp ? inp.value.trim().toUpperCase() : '';
  if(!tag){ errEl.textContent = 'Digite ou selecione uma tag.'; return; }
  if(!selIds.size){ errEl.textContent = 'Nenhum caso selecionado.'; return; }
  errEl.textContent = '';

  const ids   = [...selIds];
  const total = ids.length;
  const btnEl = document.getElementById('bt-submit');
  if(btnEl){ btnEl.disabled = true; btnEl.textContent = `Aplicando em ${total}…`; }

  try{
    /* Uma única chamada — backend lê a planilha 1× e grava as N linhas. */
    const r = await api('bulk_add_tag', {ids: ids.join(','), tag}, 'POST');
    if(btnEl){ btnEl.disabled = false; btnEl.textContent = 'Aplicar em todos'; }
    document.getElementById('btv').classList.remove('open');

    if(!r.ok){ showToast('Erro: ' + (r.error || 'falha ao aplicar tag')); return; }

    /* Atualização local — evita reload completo da base. */
    const applied = r.applied || [];
    applied.forEach(id => {
      const c = casos.find(x => x.id === id);
      if(c){
        if(!Array.isArray(c.tags)) c.tags = [];
        if(!c.tags.includes(tag)) c.tags.push(tag);
      }
    });
    if(typeof applyFilter === 'function') applyFilter(true);

    const okN   = applied.length;
    const skipN = (r.skipped || []).length;
    const errN  = (r.errors  || []).length;
    if(errN){
      showToast(`Tag "${tag}": ${okN} aplicada(s)${skipN?`, ${skipN} já tinha(m)`:''}, ${errN} erro(s)`);
    } else {
      showToast(`✅ Tag "${tag}" em ${okN} caso(s)${skipN?` (${skipN} já tinha)`:''}!`);
      clearSel();
    }
  } catch(e){
    if(btnEl){ btnEl.disabled = false; btnEl.textContent = 'Aplicar em todos'; }
    showToast('Erro de conexão: ' + e.message);
  }
}
