/* Painel do caso (modal): chips de UF/cidade/profissional, tags, add/remove uso,
   bloqueio/desbloqueio e remoção em lote. */

let currentCaso = null;
let pendingForce = false;
let pendingRemovals = {ufs:[], cidades:[], clientes:[]};
let pendingUsos = [];
let currentPhotos = [];
let addCities = [];
let _ibgeLoading = {};

async function openModal(id){
  prioritizeCase(id);
  currentCaso = casos.find(c => c.id === id);
  if(!currentCaso) return;
  document.getElementById('addform').style.display = 'none';
  document.getElementById('aerr').textContent = '';
  document.getElementById('state-warn').style.display = 'none';
  pendingForce = false;
  pendingUsos = [];
  renderPendingUsos();
  document.getElementById('auf').innerHTML = '<option value="">Selecione...</option>';
  ESTADOS.forEach(e => document.getElementById('auf').appendChild(new Option(`${e.s} – ${e.n}`, e.s)));
  const aci = document.getElementById('aci');
  aci.value = ''; aci.dataset.val = ''; aci.readOnly = true;
  aci.placeholder = 'Selecione o estado primeiro...';
  document.getElementById('apro').value = '';
  document.getElementById('prosug').style.display = 'none';

  document.getElementById('mid').textContent = currentCaso.id;
  renderPainelStatus();
  renderBlockBanner();
  renderTagEditor();
  renderModalChips();
  renderPainelActions();

  const sec = document.getElementById('mps');
  sec.innerHTML = '<div style="padding:.5rem 0;font-size:12px;color:var(--tx2)"><span class="spin"></span> Buscando fotos...</div>';
  document.getElementById('ov').classList.add('open');
  currentPhotos = [];
  try{
    const r = await api(`photos&id=${encodeURIComponent(id)}`);
    if(!r.photos?.length){ sec.innerHTML = '<div style="padding:.5rem 0;font-size:12px;color:var(--tx3)">Nenhuma foto/vídeo no Drive.</div>'; return; }
    currentPhotos = r.photos;
    sec.innerHTML = '<div class="photo-grid" id="photo-grid"></div>';
    const grid = document.getElementById('photo-grid');
    grid.innerHTML = r.photos.map((p, i) => {
      const tag = p.version_tag || '';
      const thumb = p.thumb_url || '';
      const safeName = esc(p.name);
      const cloudUrl = esc(p.webViewLink || '#');
      let body;
      if(p.isVideo){
        body = `<div class="photo-thumb-wrap video" onclick="openLightboxFlo(${i})" title="Pré-visualizar vídeo">
          ${thumb ? `<img src="${thumb}" loading="lazy" style="opacity:.55">` : ''}
          <span style="position:absolute;display:flex;flex-direction:column;align-items:center;gap:3px;color:#fff">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.5"><polygon points="5,3 19,12 5,21"/></svg>
            <span style="font-size:10px">Vídeo</span>
          </span>
          ${tag ? `<div class="ver-badge">${esc(tag)}</div>` : ''}
        </div>`;
      } else {
        body = `<div class="photo-thumb-wrap" onclick="openLightboxFlo(${i})" title="Abrir visualizador">
          ${thumb ? `<img src="${thumb}" loading="lazy" onerror="this.style.display='none'">` : '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--tx3)">sem thumb</div>'}
          ${tag ? `<div class="ver-badge">${esc(tag)}</div>` : ''}
        </div>`;
      }
      return `<div class="photo-card" data-pidx="${i}">
        ${body}
        <div class="photo-name" title="${safeName}">${safeName}</div>
        <div class="photo-actions">
          <button onclick="window.open('${cloudUrl}','_blank')" title="Abrir no Google Drive">☁ Drive</button>
          <button id="dlbtn-${i}" onclick="downloadSingleFile('${esc(p.id)}', '${safeName.replace(/'/g,"\\'")}', this)" title="Baixar diretamente">⬇ Baixar</button>
        </div>
      </div>`;
    }).join('');
  } catch(e){
    sec.innerHTML = `<div style="padding:.5rem 0;font-size:12px;color:var(--rtx)">Erro: ${esc(e.message)}</div>`;
  }
}

function renderPainelStatus(){
  const c = currentCaso;
  if(!c) return;
  const wrap = document.getElementById('painel-status');
  if(!wrap) return;
  const isBlocked = !!c.bloqueado;
  const realUfs = (c.ufs||[]).filter(u => !isBlockMarker(u));
  const inUse = realUfs.length > 0;
  const tags = Array.isArray(c.tags) ? c.tags : [];
  let pills = '';
  if(isBlocked)     pills += '<span class="pst-pill blocked">🔒 Bloqueado</span>';
  else if(inUse)    pills += '<span class="pst-pill used">Em uso</span>';
  else              pills += '<span class="pst-pill ok">Disponível</span>';
  pills += `<span style="font-size:11px;color:var(--tx3)">${realUfs.length} UF${realUfs.length===1?'':'s'} · ${(c.cidades||[]).filter((_,i)=>!isBlockMarker((c.ufs||[])[i])).length} cidade(s) · ${tags.length} tag(s)</span>`;
  wrap.innerHTML = pills;
}

function renderBlockBanner(){
  const c = currentCaso;
  if(!c) return;
  const wrap = document.getElementById('block-banner-wrap');
  if(!wrap) return;
  if(!c.bloqueado){ wrap.innerHTML = ''; return; }
  const motivo = c.motivo_bloqueio || '(sem motivo registrado — bloqueio antigo)';
  wrap.innerHTML = `<div class="block-banner">
    <div class="ic">🔒</div>
    <div class="reason"><b>Caso bloqueado</b>${esc(motivo)}</div>
  </div>`;
}

function renderTagEditor(){
  const c = currentCaso;
  if(!c) return;
  const ed = document.getElementById('tag-editor');
  if(!ed) return;
  const tags = Array.isArray(c.tags) ? c.tags : [];
  const chips = tags.map(t =>
    `<span class="tag-pill">${esc(t)}<span class="x" onclick="removeTagFromCaso('${esc(t).replace(/'/g,"\\'")}')" title="Remover esta tag">×</span></span>`
  ).join('');
  ed.innerHTML = `${chips}<div class="tag-input-wrap"><input id="tag-input-modal" type="text" placeholder="+ Adicionar tag (ex: RINO, BOTOX)..." oninput="onTagModalInput()" onfocus="onTagModalInput()" onkeydown="if(event.key==='Enter'){event.preventDefault();addTagFromInput()}" autocomplete="off"><div class="dd" id="tag-modal-dd"></div></div>`;
}

function onTagModalInput(){
  const inp = document.getElementById('tag-input-modal');
  if(!inp) return;
  const q = inp.value.trim().toUpperCase();
  const cur = new Set(currentCaso?.tags || []);
  /* Autocomplete usa SÓ a lista canônica (definida pelo admin) — usuários não
     podem inventar tags novas. A lista canônica é carregada em canonicalTags. */
  const all = (Array.isArray(canonicalTags) ? canonicalTags : []).filter(t => !cur.has(t));
  renderDD('tag-modal-dd', all, q, t => {
    inp.value = t;
    document.getElementById('tag-modal-dd').classList.remove('open');
    addTagFromInput();
  });
}

/* Aceita letras acentuadas (\p{L}) e dígitos Unicode (\p{N}); o flag `u` é
   obrigatório e proíbe escapes redundantes — & e + ficam literais, - vai no
   fim do character class. A tag precisa estar na lista canônica (validação
   também ocorre no backend). */
async function addTagFromInput(){
  const inp = document.getElementById('tag-input-modal');
  if(!inp || !currentCaso) return;
  const tag = inp.value.trim().toUpperCase().replace(/[^\p{L}\p{N} &+-]/gu, '').replace(/\s+/g, ' ').trim();
  if(!tag) return;
  if(tag.length > 30){ showToast('Tag muito longa (máx. 30 chars).'); return; }
  if(Array.isArray(canonicalTags) && !canonicalTags.includes(tag)){
    showToast(`Tag "${tag}" não está cadastrada. Peça a um admin para adicioná-la em Admin Mode → Gerenciar tags.`);
    return;
  }
  inp.disabled = true;
  try{
    const r = await api('add_tag', {caso_id: currentCaso.id, row: currentCaso.row, tag}, 'POST');
    if(r.ok){
      updateCasoLocal(currentCaso.id, {tags: r.tags});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      renderTagEditor(); renderPainelStatus();
      showToast(r.msg || `Tag "${tag}" adicionada`);
      if(!allTags.includes(tag)){ allTags.push(tag); allTags.sort(); }
    } else { showToast('Erro: '+(r.error||'falha')); }
  } catch(e){ showToast('Erro de conexão.'); }
  inp.disabled = false;
  inp.value = '';
  document.getElementById('tag-modal-dd').classList.remove('open');
  inp.focus();
}

async function removeTagFromCaso(tag){
  if(!currentCaso) return;
  if(!confirm(`Remover a tag "${tag}" deste caso?`)) return;
  try{
    const r = await api('remove_tag', {caso_id: currentCaso.id, row: currentCaso.row, tag}, 'POST');
    if(r.ok){
      updateCasoLocal(currentCaso.id, {tags: r.tags});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      renderTagEditor(); renderPainelStatus();
      showToast('Tag removida');
    } else { showToast('Erro: '+(r.error||'falha')); }
  } catch(e){ showToast('Erro de conexão.'); }
}

function renderPainelActions(){
  const c = currentCaso;
  if(!c) return;
  const mact = document.getElementById('mact');
  if(!mact) return;
  const isBlocked = !!c.bloqueado;
  const isAdmin = (typeof userRole !== 'undefined' && userRole === 'admin');
  let html = '';
  if(isBlocked){
    if(isAdmin) html += `<button class="btn bp" style="flex:1;justify-content:center;background:#fbbf24;color:#1f1f1f" onclick="confirmUnblockCaso()">🔓 Desbloquear caso</button>`;
    else        html += `<button class="btn bs" style="flex:1;justify-content:center" disabled title="Apenas administradores podem desbloquear">🔓 Desbloqueio (apenas admin)</button>`;
  } else {
    html += `<button class="btn bp" style="flex:1;justify-content:center" onclick="document.getElementById('addform').style.display='block'">+ Registrar uso</button>`;
    html += `<button class="btn bd-r" style="padding:8px 12px;font-size:12px" onclick="confirmBlockCaso()" title="Bloquear este caso para uso">🔒 Bloquear</button>`;
  }
  html += `<button class="btn bs" style="padding:8px 12px;font-size:12px" onclick="clearCaseCache('${c.id}')">🗑 Cache</button>`;
  html += `<button class="btn bs" onclick="closeModal()">Fechar</button>`;
  mact.innerHTML = html;
}

async function confirmBlockCaso(){
  if(!currentCaso) return;
  const motivo = prompt(`Bloquear ${currentCaso.id}?\n\nDigite o MOTIVO do bloqueio (obrigatório, máx. 250 chars):\n\nExemplos: "Cliente solicitou retirar", "Erro de cadastro", "Imagem com problema"`, '');
  if(motivo === null) return;
  const m = motivo.trim();
  if(!m){ showToast('Motivo obrigatório.'); return; }
  try{
    const r = await api('set_block', {caso_id: currentCaso.id, row: currentCaso.row, motivo: m}, 'POST');
    if(r.ok){
      const patch = r.depois || {};
      updateCasoLocal(currentCaso.id, {ufs:patch.ufs, cidades:patch.cidades, clientes:patch.clientes, tags:patch.tags, motivo_bloqueio:patch.motivo_bloqueio, bloqueado:patch.bloqueado});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      renderPainelStatus(); renderBlockBanner(); renderModalChips(); renderPainelActions();
      showToast('Caso bloqueado.');
      bgSyncCaso(currentCaso.id);
    } else { showToast('Erro: '+(r.error||'falha')); }
  } catch(e){ showToast('Erro de conexão.'); }
}

async function confirmUnblockCaso(){
  if(!currentCaso) return;
  if(!confirm(`Desbloquear ${currentCaso.id}?\n\nO marcador de bloqueio será removido e o caso voltará a ficar disponível.`)) return;
  try{
    const r = await api('unblock_case', {caso_id: currentCaso.id, row: currentCaso.row}, 'POST');
    if(r.ok){
      const patch = r.depois || {};
      updateCasoLocal(currentCaso.id, {ufs:patch.ufs, cidades:patch.cidades, clientes:patch.clientes, tags:patch.tags, motivo_bloqueio:patch.motivo_bloqueio, bloqueado:patch.bloqueado});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      renderPainelStatus(); renderBlockBanner(); renderModalChips(); renderPainelActions();
      showToast('Caso desbloqueado.');
      bgSyncCaso(currentCaso.id);
    } else { showToast('Erro: '+(r.error||'falha')); }
  } catch(e){ showToast('Erro de conexão.'); }
}

/* Chips do painel. UF aparece deduplicada (várias cidades na mesma UF mostram
   só uma vez). UF é clicável para remoção mas com guarda: o usuário só pode
   marcar uma UF se também tiver marcado ao menos uma cidade e um profissional —
   evita deixar entradas órfãs em cidades/clientes. */
function renderModalChips(){
  if(!currentCaso) return;
  const c = currentCaso;
  pendingRemovals = {ufs:[], cidades:[], clientes:[], _keys: new Set()};

  const _ufSeen = new Set();
  const ufChips = c.ufs.map((u, i) => ({u, i})).filter(o => {
    if(isBlockMarker(o.u)) return false;
    if(_ufSeen.has(o.u)) return false;
    _ufSeen.add(o.u);
    return true;
  });
  document.getElementById('mufs').innerHTML = ufChips.length
    ? ufChips.map(({u, i}) => `<span class="chip uf rm" id="chip-uf-${i}" onclick="toggleRemoval('ufs','${esc(u)}',${i},this)" title="Para remover este estado, selecione antes uma cidade e um profissional.">${esc(u)} ×</span>`).join('')
    : '<span style="font-size:12px;color:var(--tx3)">Nenhum</span>';

  document.getElementById('mcities').innerHTML = c.cidades.length
    ? c.cidades.map((x, i) => `<span class="chip city rm" id="chip-cid-${i}" onclick="toggleRemoval('cidades','${esc(x).replace(/'/g,"\\'")}',${i},this)" title="Clique para selecionar para remoção">${esc(cap(x))} ×</span>`).join('')
    : '<span style="font-size:12px;color:var(--tx3)">Nenhuma</span>';

  document.getElementById('mpers').innerHTML = c.clientes.length
    ? c.clientes.map((p, i) => `<span class="chip person rm" id="chip-cli-${i}" onclick="toggleRemoval('clientes','${esc(p).replace(/'/g,"\\'")}',${i},this)" title="Clique para selecionar para remoção">${esc(p)} ×</span>`).join('')
    : '<span style="font-size:12px;color:var(--tx3)">Nenhum</span>';

  const sec = document.getElementById('remove-uso-section');
  if(sec){
    sec.style.display = 'block';
    document.getElementById('remove-uso-list').innerHTML =
      `<div style="font-size:12px;color:var(--tx2);margin-bottom:.5rem">Clique nos chips acima para selecionar itens a remover.</div>
       <button id="batch-remove-btn" class="btn bd-r" style="display:none;font-size:12px" onclick="confirmBatchRemove()">✕ Remover selecionados</button>`;
  }
}

function toggleRemoval(tipo, valor, idx, btn){
  const key = `${tipo}:${idx}:${valor}`;
  if(!pendingRemovals._keys) pendingRemovals._keys = new Set();
  const isSelecting = !pendingRemovals._keys.has(key);

  /* Guarda: marcar uma UF exige que ao menos uma cidade e um profissional
     também estejam marcados — sem isso a remoção da UF deixaria entradas
     órfãs em cidades/clientes. Desmarcar (toggle off) sempre é permitido. */
  if(isSelecting && tipo === 'ufs'){
    if(pendingRemovals.cidades.length === 0 || pendingRemovals.clientes.length === 0){
      showToast('Selecione antes uma cidade e um profissional para remover junto com o estado.');
      return;
    }
  }

  if(!isSelecting){
    pendingRemovals._keys.delete(key);
    pendingRemovals[tipo] = pendingRemovals[tipo].filter(x => !(x.idx === idx && x.valor === valor));
    btn.style.background = ''; btn.style.color = 'var(--rtx)';
  } else {
    pendingRemovals._keys.add(key);
    pendingRemovals[tipo].push({idx, valor});
    btn.style.background = 'var(--rtx)'; btn.style.color = '#fff';
  }
  updateBatchRemoveBtn();
}

function updateBatchRemoveBtn(){
  const total = (pendingRemovals.ufs.length + pendingRemovals.cidades.length + pendingRemovals.clientes.length);
  const btn = document.getElementById('batch-remove-btn');
  if(!btn) return;
  btn.style.display = total > 0 ? 'inline-flex' : 'none';
  btn.textContent = `✕ Remover ${total} selecionado(s)`;
}

function confirmBatchRemove(){
  if(!currentCaso) return;
  const total = (pendingRemovals.ufs.length + pendingRemovals.cidades.length + pendingRemovals.clientes.length);
  if(!total) return;

  const counts = {ufs: pendingRemovals.ufs.length, cidades: pendingRemovals.cidades.length, clientes: pendingRemovals.clientes.length};
  const maxCount = Math.max(...Object.values(counts));
  const minCount = Math.min(...Object.values(counts).filter(v => v > 0));
  const unbalanced = maxCount > 1 && maxCount !== minCount;

  const changeList = [
    ...pendingRemovals.ufs.map(x => ({label:'Estado', val:x.valor})),
    ...pendingRemovals.cidades.map(x => ({label:'Cidade', val:cap(x.valor)})),
    ...pendingRemovals.clientes.map(x => ({label:'Profissional', val:x.valor})),
  ];
  const extra = unbalanced ? `⚠️ Atenção: você está removendo quantidades diferentes por tipo (${counts.ufs} UF, ${counts.cidades} cidade, ${counts.clientes} prof). Confirme que isso é intencional.` : '';

  showConfirm('Confirmar remoções em lote',
    `Remover ${total} item(ns) de <b>${currentCaso.id}</b>?${extra ? '<br><br><span style="color:var(--atx);font-size:12px">'+extra+'</span>' : ''}`,
    changeList,
    async () => {
      document.getElementById('confirm-modal').classList.remove('open');
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:700;display:flex;align-items:center;justify-content:center';
      overlay.innerHTML = '<div style="background:var(--sf);border-radius:var(--r);padding:2rem 2.5rem;text-align:center"><span class="spin" style="width:28px;height:28px;border-width:3px"></span><div style="margin-top:.75rem;font-size:14px;font-weight:500">Removendo...</div></div>';
      document.body.appendChild(overlay);

      let errs = [];
      for(const {idx, valor} of pendingRemovals.ufs){
        const r = await api('remove_item', {caso_id: currentCaso.id, row: currentCaso.row, tipo:'uf', valor, idx}, 'POST').catch(e => ({ok:false, error:e.message}));
        if(!r.ok) errs.push(`UF ${valor}: ${r.error}`);
      }
      for(const {idx, valor} of pendingRemovals.cidades){
        const r = await api('remove_item', {caso_id: currentCaso.id, row: currentCaso.row, tipo:'cidade', valor, idx}, 'POST').catch(e => ({ok:false, error:e.message}));
        if(!r.ok) errs.push(`Cidade ${cap(valor)}: ${r.error}`);
      }
      for(const {idx, valor} of pendingRemovals.clientes){
        const r = await api('remove_item', {caso_id: currentCaso.id, row: currentCaso.row, tipo:'cliente', valor, idx}, 'POST').catch(e => ({ok:false, error:e.message}));
        if(!r.ok) errs.push(`Prof ${valor}: ${r.error}`);
      }

      document.body.removeChild(overlay);
      pendingRemovals = {ufs:[], cidades:[], clientes:[], _keys: new Set()};
      const casoId = currentCaso.id;
      try {
        const refreshed = await api('casos');
        if(refreshed.ok){ casos = refreshed.casos || []; allProfs = refreshed.profissionais || []; }
      } catch(e){}
      currentCaso = casos.find(c => c.id === casoId);
      applyFilter();
      if(currentCaso) renderModalChips();
      if(errs.length) showToast(`${errs.length} erro(s): ${errs[0]}`);
      else showToast('Itens removidos com sucesso!');
    }
  );
}

async function removeItem(tipo, valor, idx){
  if(!currentCaso) return;
  const tipoLabel = {ufs:'estado', cidades:'cidade', clientes:'profissional'}[tipo] || tipo;
  const labelValor = tipo === 'cidades' ? cap(valor) : valor;
  const tipoAPI = {ufs:'uf', cidades:'cidade', clientes:'cliente'}[tipo] || tipo;

  showConfirm(
    `Remover ${tipoLabel}`,
    `Remover <b>${esc(labelValor)}</b> de <b>${currentCaso.id}</b>?`,
    [{label:'Caso', val:currentCaso.id}, {label:tipoLabel.charAt(0).toUpperCase()+tipoLabel.slice(1), val:labelValor}],
    async () => {
      try{
        const r = await api('remove_item', {caso_id: currentCaso.id, row: currentCaso.row, tipo: tipoAPI, valor, idx}, 'POST');
        if(r.ok){
          showToast(`${tipoLabel} removido!`);
          if(r.depois) updateCasoLocal(currentCaso.id, {ufs:r.depois.ufs, cidades:r.depois.cidades, clientes:r.depois.clientes});
          currentCaso = casos.find(c => c.id === currentCaso.id);
          if(currentCaso) renderModalChips();
          bgSyncCaso(currentCaso?.id);
        } else showToast('Erro: '+(r.error||'falha ao remover'));
      } catch(e){ showToast('Erro de conexão.'); }
    }
  );
}

function closeModal(){ document.getElementById('ov').classList.remove('open'); currentCaso = null; }
function ovClick(e){ if(e.target === document.getElementById('ov')) closeModal(); }
function openLB(u){ document.getElementById('lbi').src = u; document.getElementById('lb').classList.add('open'); }

/* loadIBGE: assíncrono e não bloqueia o filtro principal. readOnly é aplicado
   apenas em inputs DENTRO de modais — o fci do filtro principal nunca recebe. */
async function loadIBGE(uf, t){
  if(_ibgeLoading[t]) return;
  _ibgeLoading[t] = true;
  const modalInputId = {add:'aci', ba:'baci', bi:'bici'}[t];
  const ciEl = modalInputId ? document.getElementById(modalInputId) : null;
  if(ciEl){ ciEl.readOnly = true; ciEl.placeholder = 'Carregando cidades...'; }
  try{
    const r = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`);
    const d = await r.json();
    const c = d.map(x => x.nome.toUpperCase());
    if(t === 'filter')   ibgeCities = c;
    else if(t === 'add') addCities = c;
    else                 bulkCities[t] = c;
  } catch(e){
    if(t === 'filter')   ibgeCities = [];
    else if(t === 'add') addCities = [];
    else                 bulkCities[t] = [];
  } finally {
    _ibgeLoading[t] = false;
    if(ciEl){ ciEl.readOnly = false; ciEl.placeholder = 'Pesquise a cidade...'; }
  }
}

async function onAddUF(){
  const uf = document.getElementById('auf').value;
  const aci = document.getElementById('aci');
  aci.value = ''; aci.dataset.val = '';
  addCities = [];
  aci.readOnly = true;
  document.getElementById('state-warn').style.display = 'none';
  pendingForce = false;
  if(uf){
    aci.placeholder = 'Carregando cidades...';
    await loadIBGE(uf, 'add');
    aci.readOnly = false;
    aci.placeholder = 'Pesquise a cidade...';
  }
}

function onAddCityInp(){
  renderFormDD('acdd', addCities, document.getElementById('aci').value, c => {
    const e = document.getElementById('aci');
    e.value = cap(c); e.dataset.val = c;
    document.getElementById('acdd').classList.remove('open');
  });
}

function openAddCityDD(){ if(!document.getElementById('aci').readOnly) onAddCityInp(); }

function onAddProf(){ buildProfAC('apro', 'aprodd', 'prosug'); }

function prepareConfirm(type){
  const getErr = t => document.getElementById(t === 'add' ? 'aerr' : t === 'bulk-grid' ? 'baerr' : 'bierr2');
  const err = getErr(type);
  if(err) err.textContent = '';
  if(type === 'add'){
    /* Monta o batch final: pendingUsos + (linha atual se preenchida). */
    const uf = document.getElementById('auf').value;
    const city = (document.getElementById('aci').dataset.val || '').toUpperCase();
    const prof = document.getElementById('apro').value.trim();
    const batch = pendingUsos.slice();
    const currentHasData = uf || city || prof;
    if(currentHasData){
      if(!uf || !city || !prof){
        if(err) err.textContent = 'Linha atual incompleta — preencha todos os campos ou limpe pra registrar só os adicionados.';
        return;
      }
      const dupCity = batch.some(p => p.cidade === city);
      if(dupCity){ if(err) err.textContent = `Cidade ${cap(city)} já está na lista de adicionados.`; return; }
      const dupCaso = currentCaso && currentCaso.cidades.includes(city);
      if(dupCaso){ if(err) err.textContent = `Cidade ${cap(city)} já está em uso neste caso.`; return; }
      batch.push({uf, cidade:city, profissional:prof});
    }
    if(!batch.length){ if(err) err.textContent = 'Nenhuma linha pra registrar.'; return; }

    const rows = batch.map(p => ({label:`${p.uf} / ${cap(p.cidade)}`, val:p.profissional}));
    const title = batch.length > 1 ? `Confirmar ${batch.length} registros` : 'Confirmar registro';
    showConfirm(title, `Registrar ${batch.length} uso(s) em <b>${currentCaso?.id}</b>?`, rows,
      () => submitUsoBatch(batch));
  } else if(type === 'bulk-grid'){
    const uf = document.getElementById('bauf').value;
    const city = document.getElementById('baci').dataset.val || '';
    const prof = document.getElementById('bapro').value.trim();
    if(!uf || !city || !prof){ if(err) err.textContent = 'Preencha todos os campos.'; return; }
    showConfirm('Confirmar registro em massa', `Aplicar para <b>${selIds.size}</b> casos: ${[...selIds].join(', ')}`,
      [{label:'Estado', val:uf}, {label:'Cidade', val:cap(city)}, {label:'Profissional', val:prof}],
      () => submitBulkApply());
  } else if(type === 'bulk-id'){
    const uf = document.getElementById('biuf').value;
    const city = document.getElementById('bici').dataset.val || '';
    const prof = document.getElementById('bipro').value.trim();
    if(!uf || !city || !prof){ if(err) err.textContent = 'Preencha todos os campos.'; return; }
    if(!bulkSelIds.size){ if(err) err.textContent = 'Nenhum caso selecionado.'; return; }
    showConfirm('Confirmar registro por ID', `Aplicar para <b>${bulkSelIds.size}</b> casos: ${[...bulkSelIds].join(', ')}`,
      [{label:'Estado', val:uf}, {label:'Cidade', val:cap(city)}, {label:'Profissional', val:prof}],
      () => submitBulkById());
  }
}

function prepareRemoveUso(idx){
  if(!currentCaso) return;
  showConfirm('Confirmar remoção', `Remover uso do <b>${currentCaso.id}</b>?`,
    [{label:'Estado', val:currentCaso.ufs[idx]||''}, {label:'Cidade', val:cap(currentCaso.cidades[idx]||'')}, {label:'Profissional', val:currentCaso.clientes[idx]||''}],
    () => removeUso(idx));
}

/* Adiciona a linha atual do formulário à lista pendente (batch local) com
   validações imediatas. O envio efetivo só acontece no submitUsoBatch. */
function addPendingUso(){
  const err = document.getElementById('aerr');
  err.textContent = '';
  const uf = document.getElementById('auf').value;
  const city = (document.getElementById('aci').dataset.val || '').toUpperCase();
  const prof = document.getElementById('apro').value.trim();
  if(!uf || !city || !prof){
    err.textContent = 'Preencha UF, cidade e profissional antes de adicionar.';
    return;
  }
  if(pendingUsos.some(p => p.cidade === city)){
    err.textContent = `Cidade ${cap(city)} já está na lista de adicionados.`;
    return;
  }
  if(currentCaso && currentCaso.cidades.includes(city)){
    err.textContent = `Cidade ${cap(city)} já está em uso neste caso.`;
    return;
  }
  pendingUsos.push({uf, cidade:city, profissional:prof});
  /* Limpa o formulário pra próxima entrada. */
  document.getElementById('auf').value = '';
  const aci = document.getElementById('aci');
  aci.value = ''; aci.dataset.val = ''; aci.readOnly = true;
  aci.placeholder = 'Selecione o estado primeiro...';
  document.getElementById('apro').value = '';
  document.getElementById('prosug').style.display = 'none';
  document.getElementById('state-warn').style.display = 'none';
  pendingForce = false;
  renderPendingUsos();
  updateAddBtnLabel();
}

function removePendingUso(i){
  pendingUsos.splice(i, 1);
  renderPendingUsos();
  updateAddBtnLabel();
}

function renderPendingUsos(){
  const box = document.getElementById('pending-usos-list');
  if(!box) return;
  if(!pendingUsos.length){ box.innerHTML = ''; box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = `<div style="font-size:10px;color:var(--tx2);text-transform:uppercase;letter-spacing:.06em;font-weight:700;margin-bottom:6px">Adicionados (${pendingUsos.length})</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px">${pendingUsos.map((p,i) =>
      `<span class="tag-pill" style="font-size:12px;background:var(--gbg);color:var(--gtx)">${esc(p.uf)} / ${esc(cap(p.cidade))} / ${esc(p.profissional)}<span class="x" onclick="removePendingUso(${i})" title="Remover esta linha">×</span></span>`
    ).join('')}</div>`;
}

function updateAddBtnLabel(){
  const btn = document.getElementById('abtn');
  if(!btn) return;
  let total = pendingUsos.length;
  const uf = document.getElementById('auf').value;
  const city = (document.getElementById('aci').dataset.val || '').toUpperCase();
  const prof = document.getElementById('apro').value.trim();
  if(uf && city && prof) total++;
  btn.textContent = total > 1 ? `Registrar ${total} usos` : 'Registrar uso';
}

function cancelAddForm(){
  pendingUsos = [];
  renderPendingUsos();
  document.getElementById('addform').style.display = 'none';
}

/* Submete o batch via add_uso_batch (atomicidade: pré-flight valida tudo
   antes de tocar no Sheets). Se backend devolver warn (UF já em uso, etc),
   exibe o aviso e oferece "Sim, continuar" com force=1. */
async function submitUsoBatch(batch, force = false){
  const err = document.getElementById('aerr'), btn = document.getElementById('abtn'), warnEl = document.getElementById('state-warn');
  err.textContent = '';
  warnEl.style.display = 'none';
  const orig = btn.textContent;
  btn.innerHTML = '<span class="spin"></span> Salvando...';
  btn.disabled = true;
  try{
    const params = {
      caso_id: currentCaso.id,
      row: currentCaso.row,
      entries: JSON.stringify(batch),
    };
    if(force || pendingForce) params.force = '1';
    const r = await api('add_uso_batch', params, 'POST');
    if(r.ok){
      showToast(`${r.count || batch.length} uso(s) registrado(s)!`);
      pendingForce = false;
      pendingUsos = [];
      const patch = r.depois || null;
      if(patch) updateCasoLocal(currentCaso.id, {ufs:patch.ufs, cidades:patch.cidades, clientes:patch.clientes});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      if(currentCaso){ renderModalChips(); document.getElementById('addform').style.display = 'none'; }
      bgSyncCaso(currentCaso?.id);
    } else if(r.warn){
      warnEl.style.display = 'block';
      warnEl.innerHTML = `⚠️ ${esc(r.msg)}<div style="display:flex;gap:8px;margin-top:.5rem"><button class="btn bp" style="padding:5px 12px;font-size:12px" id="warn-continue-btn">Sim, continuar</button><button class="btn bs" style="padding:5px 12px;font-size:12px" onclick="document.getElementById('state-warn').style.display='none'">Cancelar</button></div>`;
      document.getElementById('warn-continue-btn').onclick = () => {
        pendingForce = true;
        warnEl.style.display = 'none';
        submitUsoBatch(batch, true);
      };
      pendingForce = false;
    } else {
      const lines = Array.isArray(r.errors) && r.errors.length
        ? r.errors.map(e => '• '+e).join('<br>')
        : esc(r.error || 'Erro desconhecido.');
      err.innerHTML = lines;
    }
  } catch(e){ err.textContent = 'Erro de conexão.'; }
  btn.innerHTML = orig;
  btn.disabled = false;
  updateAddBtnLabel();
}

async function removeUso(idx){
  try{
    const r = await api('remove_uso', {caso_id: currentCaso.id, row: currentCaso.row, idx}, 'POST');
    if(r.ok){
      showToast('Uso removido!');
      if(r.depois) updateCasoLocal(currentCaso.id, {ufs:r.depois.ufs, cidades:r.depois.cidades, clientes:r.depois.clientes});
      currentCaso = casos.find(c => c.id === currentCaso.id);
      if(currentCaso) renderModalChips();
      bgSyncCaso(currentCaso?.id);
    } else showToast('Erro: '+(r.error||''));
  } catch(e){ showToast('Erro.'); }
}
