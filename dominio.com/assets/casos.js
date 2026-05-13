/* Estado da grade, carregamento de casos, filtros, paginação e thumbnails. */

let PER = 24;
const MAX_CONCURRENT = 4;
const THUMB_RETRY = 'retry';
const BLOCK_MARKERS = ['NA','LINDA'];

let thumbCache = {};
let pageLoadStart = 0;
let _baseGeneration = 0;
let _pageGeneration = 0;
let _highPriorityIds = new Set();
let _loadingCount = 0;
let casos = [], filtered = [], page = 1;
let mode = 'estado', selUF = '', selCity = '', selProf = '';
let ibgeCities = [];
let allProfs = [];
let allTags = [];
let canonicalTags = [];
let selTags = new Set();
const carIndex = {};
let _profSearchTimer = null;
let _userTouchedShow = false;

function isBlockMarker(v){ return BLOCK_MARKERS.includes((v||'').toString().trim().toUpperCase()); }

async function loadCasos(silent = false){
  if(!silent){
    document.getElementById('grid').innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:2.5rem;color:var(--tx2)"><span class="spin"></span> Carregando...</div>';
    document.getElementById('empty').style.display = 'none';
  }
  try{
    const r = await api('casos');
    if(!r.ok) throw new Error(r.error || 'Erro');
    casos = r.casos || [];
    allProfs = r.profissionais || [];
    const tagSet = new Set();
    casos.forEach(c => (c.tags||[]).forEach(t => tagSet.add(t)));
    allTags = [...tagSet].sort();
    applyFilter();
  } catch(e){
    document.getElementById('grid').innerHTML = '';
    document.getElementById('empty').style.display = 'block';
    document.getElementById('empty').innerHTML = `<div style="color:var(--rtx);margin-bottom:.75rem">⚠️ ${esc(e.message)}</div><button class="btn bs" onclick="showView('admin');runDiag()">🔧 Diagnóstico</button>`;
  }
}

/* Atualiza um caso no array local sem round-trip ao servidor — usado após
   mutações bem-sucedidas para evitar loadCasos(true) bloqueante. */
function updateCasoLocal(casoId, patch){
  const idx = casos.findIndex(c => c.id === casoId);
  if(idx === -1) return false;
  casos[idx] = {...casos[idx], ...patch};
  const profs = new Set();
  casos.forEach(c => c.clientes.forEach(p => { if(p) profs.add(p); }));
  allProfs = [...profs].sort();
  applyFilter();
  return true;
}

/* Sincroniza um caso do servidor em background, respeitando a geração ativa. */
function bgSyncCaso(casoId){
  const myBaseGen = _baseGeneration;
  setTimeout(async () => {
    try{
      if(myBaseGen !== _baseGeneration) return;
      const r = await api('casos');
      if(r.ok && myBaseGen === _baseGeneration){ casos = r.casos || []; allProfs = r.profissionais || []; }
    } catch(e){}
  }, 2000);
}

async function syncNow(){ showToast('Sincronizando...'); await loadCasos(); showToast('Dados atualizados!'); }

/* Atualização agressiva: ignora o cache MySQL (TTL 5 min) e força leitura
   direta do Google Sheets. Usar quando o usuário acabou de adicionar casos
   novos e o "Sincronizar dados" ainda traz a versão cacheada. */
async function forceRefresh(){
  const btn = document.getElementById('btn-refresh');
  const orig = btn ? btn.innerHTML : '';
  if(btn){ btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Atualizando...'; }
  showToast('Forçando atualização (ignorando cache)...');
  try{
    const r = await api('casos&force=1');
    if(!r.ok) throw new Error(r.error || 'Erro');
    casos = r.casos || [];
    allProfs = r.profissionais || [];
    const tagSet = new Set();
    casos.forEach(c => (c.tags||[]).forEach(t => tagSet.add(t)));
    allTags = [...tagSet].sort();
    thumbCache = {};
    _baseGeneration++;
    applyFilter();
    checkNewFiles();
    showToast(`✓ ${casos.length} casos sincronizados.`);
  } catch(e){
    showToast('Erro ao atualizar: '+e.message);
  } finally {
    if(btn){ btn.disabled = false; btn.innerHTML = orig; }
  }
}

async function checkNewFiles(){
  try{
    const r = await api('new_files');
    if(r.ok && r.count > 0){
      document.getElementById('nat').textContent = `${r.count} novo(s) arquivo(s) no Drive (últimos 7 dias).`;
      document.getElementById('na').style.display = 'flex';
    }
  } catch(e){}
}

function setMode(m){
  mode = m;
  selUF = ''; selCity = ''; ibgeCities = [];
  document.getElementById('fuf').value = '';
  document.getElementById('fci').value = '';
  document.getElementById('te').classList.toggle('active', m === 'estado');
  document.getElementById('tc').classList.toggle('active', m === 'cidade');
  document.getElementById('cw').style.display = m === 'cidade' ? 'block' : 'none';
  applyFilter();
}

async function onUFChange(){
  selUF = document.getElementById('fuf').value;
  selCity = '';
  ibgeCities = [];
  document.getElementById('fci').value = '';
  if(selUF && mode === 'cidade') await loadIBGE(selUF, 'filter');
  applyFilter();
}

function onCityInput(){
  const q = document.getElementById('fci').value;
  renderDD('cdd', ibgeCities, q, c => {
    selCity = c;
    document.getElementById('fci').value = cap(c);
    document.getElementById('cdd').classList.remove('open');
    applyFilter();
  });
  if(!q){ selCity = ''; applyFilter(); }
}

function openCityDD(){
  renderDD('cdd', ibgeCities, document.getElementById('fci').value, c => {
    selCity = c;
    document.getElementById('fci').value = cap(c);
    document.getElementById('cdd').classList.remove('open');
    applyFilter();
  });
}

function onShowFilterChange(){ _userTouchedShow = true; applyFilter(); }

function autoSyncShowFilter(){
  if(_userTouchedShow) return;
  const fshow = document.getElementById('fshow');
  if(!fshow) return;
  fshow.value = selProf ? 'em_uso' : 'disponivel';
}

function onProfSearch(){
  selProf = document.getElementById('fpro').value.trim();
  const q = norm(selProf);
  autoSyncShowFilter();
  if(!q){ document.getElementById('prodd').classList.remove('open'); applyFilter(); return; }
  /* Debounce 150ms — Levenshtein é O(m*n) e não deve rodar a cada tecla. */
  clearTimeout(_profSearchTimer);
  _profSearchTimer = setTimeout(() => {
    const m = allProfs.filter(p => norm(p).includes(q)).slice(0, 12);
    if(m.length){
      renderFormDD('prodd', m, '', c => {
        document.getElementById('fpro').value = c;
        selProf = c;
        autoSyncShowFilter();
        document.getElementById('prodd').classList.remove('open');
        applyFilter();
      });
    } else {
      document.getElementById('prodd').classList.remove('open');
    }
    applyFilter();
  }, 150);
}

function openProfDD(){ onProfSearch(); }

function clearFilters(){
  selUF = ''; selCity = ''; selProf = ''; selTags.clear();
  ['fuf','fci','fpro','fids','ftag'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
  renderTagFilterChips();
  _userTouchedShow = false;
  document.getElementById('fshow').value = 'disponivel';
  document.getElementById('cw').style.display = 'none';
  mode = 'estado';
  document.getElementById('te').classList.add('active');
  document.getElementById('tc').classList.remove('active');
  document.getElementById('btn-clf').style.display = 'none';
  applyFilter();
}

function getAvailableTagsForFilter(){
  const set = new Set(allTags || []);
  (casos || []).forEach(c => (c.tags||[]).forEach(t => set.add(t)));
  return [...set].sort();
}

function onTagFilterInput(){
  const inp = document.getElementById('ftag');
  const q = inp.value.trim().toUpperCase();
  const all = getAvailableTagsForFilter().filter(t => !selTags.has(t));
  renderDD('ftagdd', all, q, t => {
    selTags.add(t);
    inp.value = '';
    document.getElementById('ftagdd').classList.remove('open');
    renderTagFilterChips();
    applyFilter();
  });
}

function openTagFilterDD(){ onTagFilterInput(); }

function renderTagFilterChips(){
  const box = document.getElementById('ftag-chips');
  if(!box) return;
  box.innerHTML = [...selTags].map(t =>
    `<span class="tag-pill">${esc(t)}<span class="x" onclick="selTags.delete('${esc(t).replace(/'/g,"\\'")}');renderTagFilterChips();applyFilter()" title="Remover tag do filtro">×</span></span>`
  ).join('');
}

async function loadAllTags(){
  try{ const r = await api('list_tags'); if(r.ok) allTags = r.tags || []; } catch(e){}
}

/* Carrega a lista canônica de tags definida pelo admin. Diferente de
   `loadAllTags()` (que lê do conjunto em uso nos casos), esta é o vocabulário
   controlado — só essas tags podem ser aplicadas em novos casos. */
async function loadCanonicalTags(){
  try{
    const r = await api('list_canonical_tags');
    if(r.ok) canonicalTags = Array.isArray(r.tags) ? r.tags : [];
  } catch(e){ canonicalTags = []; }
}

/* Fecha qualquer dropdown ao clicar fora dos containers. */
document.addEventListener('click', e => {
  if(!e.target.closest('.ddw') && !e.target.closest('.fw'))
    document.querySelectorAll('.dd').forEach(d => d.classList.remove('open'));
});

/* applyFilter: o filtro por ID é INDEPENDENTE — quando preenchido, mostra
   apenas esses IDs (ignora estado/prof/exibir); tags ainda refinam a lista. */
function applyFilter(){
  const show = document.getElementById('fshow').value;
  const profQ = norm(selProf);
  const idsRaw = (document.getElementById('fids')?.value || '').trim();
  const hasStateFilter = !!(selUF || selProf);
  const hasTagFilter = selTags.size > 0;
  const hasFilter = !!(hasStateFilter || idsRaw || hasTagFilter);
  document.getElementById('btn-clf').style.display = hasFilter ? 'inline-flex' : 'none';

  const matchesTags = c => !hasTagFilter || [...selTags].every(t => (c.tags||[]).includes(t));

  if(idsRaw){
    const idSet = new Set(
      idsRaw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(n => {
        const clean = n.replace(/^CASO-?/i,'').replace(/\D/g,'');
        return clean ? `CASO-${clean}` : '';
      }).filter(Boolean)
    );
    if(idSet.size > 0){
      const list = casos
        .filter(c => idSet.has(c.id) && matchesTags(c))
        .map(c => ({...c, emUso: false}));
      filtered = list; page = 1;
      document.getElementById('st').textContent = list.length;
      document.getElementById('sd').textContent = '—';
      document.getElementById('su').textContent = '—';
      renderGrid();
      return;
    }
  }

  const allWithStatus = casos.map(c => {
    let emUso = false;
    if(profQ){
      emUso = c.clientes.some(p => norm(p).includes(profQ));
    } else if(selUF){
      if(mode === 'estado') emUso = c.ufs.includes(selUF);
      else                  emUso = selCity ? c.cidades.includes(selCity) : c.ufs.includes(selUF);
    }
    return {...c, emUso};
  });

  const tagFiltered = hasTagFilter ? allWithStatus.filter(matchesTags) : allWithStatus;

  const dispCount = tagFiltered.filter(c => !c.emUso && !c.bloqueado).length;
  const usoCount  = tagFiltered.filter(c =>  c.emUso && !c.bloqueado).length;

  let list = [...tagFiltered];
  if(show === 'disponivel')    list = list.filter(c => !c.emUso && !c.bloqueado);
  else if(show === 'em_uso')   list = list.filter(c =>  c.emUso && !c.bloqueado);
  else if(show === 'bloqueado')list = list.filter(c =>  !!c.bloqueado);

  filtered = list; page = 1;
  document.getElementById('st').textContent = list.length;
  document.getElementById('sd').textContent = hasStateFilter ? dispCount : '—';
  document.getElementById('su').textContent = hasStateFilter ? usoCount : '—';
  list.slice(0, PER).forEach(c => _highPriorityIds.add(c.id));
  renderGrid();
}

function renderGrid(){
  const grid = document.getElementById('grid'), empty = document.getElementById('empty');
  const slice = filtered.slice((page-1)*PER, page*PER);
  if(!slice.length){ grid.innerHTML = ''; empty.style.display = 'block'; renderPager(0); return; }
  empty.style.display = 'none';
  const hasFilter = !!(selUF || selProf);
  pageLoadStart = performance.now();

  grid.innerHTML = slice.map(c => {
    const isBlocked = !!c.bloqueado;
    const nv = !isBlocked && !c.ufs.length && !c.cidades.length;
    let cls, lbl;
    if(isBlocked){ cls = 'bblock'; lbl = '🔒 Bloqueado'; }
    else if(nv){ cls = 'bfree'; lbl = 'Nunca usado'; }
    else if(c.emUso){ cls = 'bused'; lbl = 'Em uso'; }
    else { cls = 'bok'; lbl = 'Disponível'; }
    const realUfs = (c.ufs||[]).filter(u => !isBlockMarker(u));
    const sub = isBlocked ? 'Bloqueado' : (realUfs.length ? realUfs.slice(0,5).join(', ') + (realUfs.length>5 ? '…' : '') : 'Sem uso');
    const isSel = selIds.has(c.id);
    const tc = thumbCache[c.id];

    let innerHtml;
    if(tc === undefined){
      innerHtml = '<div class="ct-loading"><div class="spin"></div></div>';
    } else if(tc === null){
      innerHtml = '<div class="ct-error"><div class="sad">😔</div><span>sem foto</span></div>';
    } else if(tc.versions && tc.versions.length > 1){
      const slides = tc.versions.map(v => `<div class="carousel-slide"><img src="${v.url}" alt="${c.id}" loading="lazy"></div>`).join('');
      const dots = tc.versions.map((_,i) => `<div class="carousel-dot${i===0?' active':''}"></div>`).join('');
      innerHtml = `<div class="carousel" id="car-${c.id}" onclick="event.stopPropagation()">
        <div class="carousel-slides" id="cslides-${c.id}">${slides}</div>
        <button class="carousel-btn prev" onclick="carPrev('${c.id}',${tc.versions.length})">‹</button>
        <button class="carousel-btn next" onclick="carNext('${c.id}',${tc.versions.length})">›</button>
        <div class="carousel-dots" id="cdots-${c.id}">${dots}</div>
        <div class="carousel-ver" id="cver-${c.id}">${tc.versions[0].ver}</div>
      </div>`;
    } else {
      innerHtml = `<img src="${tc.url}" alt="${c.id}" loading="lazy">${tc.isVideo ? '<div class="vid-badge">▶ Vídeo</div>' : ''}`;
    }

    const tags = Array.isArray(c.tags) ? c.tags : [];
    let tagChips = '';
    if(tags.length){
      const shown = tags.slice(0, 3);
      const more = tags.length - shown.length;
      tagChips = `<div class="ctags">${shown.map(t => `<span class="ctag">${esc(t)}</span>`).join('')}${more>0 ? `<span class="ctag" style="background:transparent;color:var(--tx3);border:0.5px dashed var(--bds)">+${more}</span>` : ''}</div>`;
    }

    return `<div class="cc${isSel?' sel':''}${isBlocked?' blocked':''}" id="card-${c.id}" style="position:relative" onclick="${selMode ? `toggleCardSel('${c.id}',event)` : `openModal('${c.id}')`}" title="${isBlocked && c.motivo_bloqueio ? 'Motivo: '+esc(c.motivo_bloqueio) : ''}">
      ${selMode ? `<div class="csel">${isSel?'✓':''}</div>` : ''}
      <div class="ct" id="ct-${c.id}">${innerHtml}</div>
      <div class="cb">
        <div class="ci">${c.id}</div>
        <div class="cs" title="${esc(sub)}">${esc(sub)}</div>
        ${hasFilter || isBlocked ? `<span class="badge ${cls}">${lbl}</span>` : ''}
        ${tagChips}
      </div>
    </div>`;
  }).join('');

  renderPager(Math.ceil(filtered.length / PER));
  lazyLoadThumbs(slice);
  setTimeout(() => preloadNextPage(), 800);
}

function carNext(id, total){ carIndex[id] = ((carIndex[id]||0)+1) % total; updateCar(id); }
function carPrev(id, total){ carIndex[id] = ((carIndex[id]||0)-1+total) % total; updateCar(id); }
function updateCar(id){
  const idx = carIndex[id] || 0;
  const s = document.getElementById('cslides-'+id);
  if(s) s.style.transform = `translateX(-${idx*100}%)`;
  const d = document.getElementById('cdots-'+id);
  if(d) d.querySelectorAll('.carousel-dot').forEach((x,i) => x.classList.toggle('active', i === idx));
  const v = document.getElementById('cver-'+id);
  const tc = thumbCache[id];
  if(v && tc?.versions) v.textContent = tc.versions[idx].ver;
}

async function fetchThumb(casoId){
  const t0 = performance.now();
  const sourceParam = thumbSourceMode === 'auto' ? '' : `&source=${thumbSourceMode}`;
  const r = await api(`photos&id=${encodeURIComponent(casoId)}${sourceParam}`);
  const ms = Math.round(performance.now() - t0);
  return {r, ms};
}

function prioritizeCase(id){ _highPriorityIds.add(id); }

function showThumbMeta(id, ms, src){
  const card = document.getElementById('card-'+id);
  if(!card) return;
  let meta = card.querySelector('.thumb-meta');
  if(!meta){ meta = document.createElement('div'); meta.className = 'thumb-meta'; card.querySelector('.cb')?.appendChild(meta); }
  const color = src === 'cache' ? 'var(--gtx)' : 'var(--btx)';
  const icon  = src === 'cache' ? '💾' : '☁️';
  meta.innerHTML = `<span style="font-size:9px;color:${color};font-weight:600">${icon} ${ms}ms</span>`;
}

function updatePageTimer(){
  if(!pageLoadStart) return;
  const ms = Math.round(performance.now() - pageLoadStart);
  const el = document.getElementById('page-load-timer');
  if(el){ el.textContent = `⏱ Página: ${ms}ms`; el.style.display = adminModeVisible ? 'flex' : 'none'; }
  pageLoadStart = 0;
}

function renderThumbEl(el, id, tc){
  if(!el || !tc) return;
  if(tc.versions && tc.versions.length > 1){
    const slides = tc.versions.map(v => `<div class="carousel-slide"><img src="${v.url}" loading="lazy"></div>`).join('');
    const dots = tc.versions.map((_,i) => `<div class="carousel-dot${i===0?' active':''}"></div>`).join('');
    el.innerHTML = `<div class="carousel" id="car-${id}" onclick="event.stopPropagation()"><div class="carousel-slides" id="cslides-${id}">${slides}</div><button class="carousel-btn prev" onclick="carPrev('${id}',${tc.versions.length})">‹</button><button class="carousel-btn next" onclick="carNext('${id}',${tc.versions.length})">›</button><div class="carousel-dots" id="cdots-${id}">${dots}</div><div class="carousel-ver" id="cver-${id}">${tc.versions[0].ver}</div></div>`;
  } else {
    el.innerHTML = `<img src="${tc.url}" alt="${id}" loading="lazy">${tc.isVideo ? '<div class="vid-badge">▶ Vídeo</div>' : ''}`;
  }
}

function renderPager(total){
  const pg = document.getElementById('pager');
  if(total <= 1 && filtered.length <= PER){ pg.innerHTML = ''; return; }
  const cur = page;
  let h = '';
  h += `<span class="pager-info">${filtered.length} casos</span>`;
  if(total > 1){
    h += `<button class="pb nav" onclick="goPage(${cur-1})" ${cur<=1?'disabled':''} title="Anterior">‹</button>`;
    const delta = 2, start = Math.max(1, cur-delta), end = Math.min(total, cur+delta);
    if(start > 1){ h += `<button class="pb" onclick="goPage(1)">1</button>`; if(start > 2) h += `<span class="pager-sep">…</span>`; }
    for(let i = start; i <= end; i++) h += `<button class="pb${i===cur?' active':''}" onclick="goPage(${i})">${i}</button>`;
    if(end < total){ if(end < total-1) h += `<span class="pager-sep">…</span>`; h += `<button class="pb" onclick="goPage(${total})">${total}</button>`; }
    h += `<button class="pb nav" onclick="goPage(${cur+1})" ${cur>=total?'disabled':''} title="Próximo">›</button>`;
    h += `<div class="pager-jump"><span>Ir para</span><input type="number" min="1" max="${total}" value="${cur}" onkeydown="if(event.key==='Enter'){const v=parseInt(this.value);if(v>=1&&v<=${total})goPage(v);else this.value='${cur}'}" onblur="this.value='${cur}'"><span>/ ${total}</span></div>`;
  }
  h += `<div class="pager-jump" style="margin-left:auto"><span>Por página:</span><select onchange="setPerPage(parseInt(this.value))" style="padding:4px 8px;border:0.5px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:12px;outline:none">
    ${[12,24,48,96].map(n => `<option value="${n}"${n===PER?' selected':''}>${n}</option>`).join('')}
  </select></div>`;
  pg.innerHTML = h;
}

function goPage(p){
  const total = Math.ceil(filtered.length / PER);
  page = Math.max(1, Math.min(p, total));
  _pageGeneration++;
  renderGrid();
  window.scrollTo(0, 0);
}

function setPerPage(n){
  PER = n;
  page = 1;
  _pageGeneration++;
  renderGrid();
  window.scrollTo(0, 0);
}

function preloadNextPage(){
  const total = Math.ceil(filtered.length / PER);
  if(page >= total) return;
  const nextSlice = filtered.slice(page*PER, (page+1)*PER);
  const toPreload = nextSlice.filter(c => thumbCache[c.id] === undefined);
  if(!toPreload.length) return;

  const myBaseGen = _baseGeneration;
  const run = async () => {
    for(let i = 0; i < toPreload.length; i += 2){
      if(myBaseGen !== _baseGeneration) return;
      const batch = toPreload.slice(i, i+2);
      await Promise.all(batch.map(async c => {
        if(thumbCache[c.id] !== undefined || myBaseGen !== _baseGeneration) return;
        try{
          const r = await api(`photos&id=${encodeURIComponent(c.id)}`);
          if(myBaseGen !== _baseGeneration) return;
          if(!r.ok || !r.photos?.length){ thumbCache[c.id] = THUMB_RETRY; return; }
          const allVideo = r.photos.every(p => p.isVideo);
          const sorted = [...r.photos].sort((a,b) => (b.isWebp?1:0)-(a.isWebp?1:0));
          const best = sorted.find(p => !p.isVideo && p.thumb_url) || sorted.find(p => p.thumb_url);
          if(!best){ thumbCache[c.id] = allVideo ? {url:null,isVideo:true,versions:null} : THUMB_RETRY; return; }
          const versioned = r.photos.filter(p => !p.isVideo && p.version && p.thumb_url);
          let versions = null;
          if(versioned.length > 1){
            const vMap = {};
            versioned.forEach(p => { if(!vMap[p.version]) vMap[p.version] = p; });
            versions = Object.entries(vMap).sort((a,b) => a[0].localeCompare(b[0])).map(([ver,p]) => ({ver, url:p.thumb_url}));
          }
          thumbCache[c.id] = {url:best.thumb_url, isVideo:allVideo, versions: versions && versions.length > 1 ? versions : null};
        } catch(e){}
      }));
      if(i + 2 < toPreload.length) await new Promise(res => setTimeout(res, 300));
    }
  };

  setTimeout(() => run(), 2000);
}

function makeSemaphore(gen, baseGen){
  return {
    count: 0, queue: [],
    acquire(){ return new Promise(r => { if(this.count < MAX_CONCURRENT){ this.count++; r(); } else this.queue.push(r); }); },
    release(){ if(this.queue.length){ this.queue.shift()(); } else this.count--; },
    stale(){ return gen !== _pageGeneration || baseGen !== _baseGeneration; }
  };
}

/* Confere o cache em lote no servidor antes de disparar N requests individuais. */
async function primeThumbCacheFromServer(slice, myBaseGen){
  const unknownIds = slice.filter(c => thumbCache[c.id] === undefined).map(c => c.id);
  if(!unknownIds.length) return;
  const t0 = performance.now();
  try{
    const r = await fetch(`api/handler.php?action=cache_status&ids=${encodeURIComponent(unknownIds.join(','))}`, {credentials:'same-origin'});
    const d = await r.json();
    if(myBaseGen !== _baseGeneration) return;
    const ms = Math.round(performance.now() - t0);
    if(!d.ok) return;
    for(const [id, thumbUrl] of Object.entries(d.cache)){
      if(thumbCache[id] === undefined && thumbUrl){
        thumbCache[id] = {url: thumbUrl, isVideo: false, versions: null, src: 'cache', ms, preloaded: true};
        const el = document.getElementById('ct-'+id);
        if(el) renderThumbEl(el, id, thumbCache[id]);
        if(adminModeVisible) showThumbMeta(id, ms, 'cache');
      }
    }
  } catch(e){}
}

async function lazyLoadThumbs(slice){
  const myGen = _pageGeneration;
  const myBaseGen = _baseGeneration;
  const stale = () => myGen !== _pageGeneration || myBaseGen !== _baseGeneration;
  await primeThumbCacheFromServer(slice, myBaseGen);
  if(stale()) return;

  slice.filter(c => { const tc = thumbCache[c.id]; return tc && tc !== 'loading' && tc !== THUMB_RETRY; }).forEach(c => {
    if(stale()) return;
    const el = document.getElementById('ct-'+c.id);
    if(!el || el.querySelector('img,canvas,.carousel')) return;
    renderThumbEl(el, c.id, thumbCache[c.id]);
    if(adminModeVisible) showThumbMeta(c.id, thumbCache[c.id].ms || 0, thumbCache[c.id].src || 'cache');
  });

  const toLoad = slice.filter(c => thumbCache[c.id] === undefined || thumbCache[c.id] === THUMB_RETRY);
  if(!toLoad.length){ updatePageTimer(); return; }
  toLoad.forEach(c => thumbCache[c.id] = 'loading');

  const sorted = [
    ...toLoad.filter(c => _highPriorityIds.has(c.id)),
    ...toLoad.filter(c => !_highPriorityIds.has(c.id)),
  ];

  const sem = makeSemaphore(myGen, myBaseGen);

  await Promise.all(sorted.map(async c => {
    await sem.acquire();
    if(sem.stale()){ thumbCache[c.id] = undefined; sem.release(); return; }
    try{
      const {r, ms} = await fetchThumb(c.id);
      if(sem.stale()){ thumbCache[c.id] = undefined; return; }
      const el = document.getElementById('ct-'+c.id);
      if(!r.ok || !r.photos?.length){
        thumbCache[c.id] = null;
        if(el) el.innerHTML = '<div class="ct-error"><div class="sad">😔</div><span>sem foto</span></div>';
        return;
      }
      const allVideo = r.photos.every(p => p.isVideo);
      const sorted2 = [...r.photos].sort((a,b) => (b.isWebp?1:0)-(a.isWebp?1:0));
      const best = sorted2.find(p => !p.isVideo && p.thumb_url) || sorted2.find(p => p.thumb_url);
      if(!best){
        if(allVideo){
          thumbCache[c.id] = {url:null, isVideo:true, versions:null, src:'drive', ms};
          if(el) el.innerHTML = '<div class="ct-error"><div style="font-size:22px">▶</div><span>Vídeo</span></div>';
        } else {
          thumbCache[c.id] = null;
          if(el) el.innerHTML = '<div class="ct-error"><div class="sad">😔</div><span>sem foto</span></div>';
        }
        return;
      }
      const versioned = r.photos.filter(p => !p.isVideo && p.version && p.thumb_url);
      let versions = null;
      if(versioned.length > 1){
        const vMap = {};
        versioned.forEach(p => { if(!vMap[p.version]) vMap[p.version] = p; });
        versions = Object.entries(vMap).sort((a,b) => a[0].localeCompare(b[0])).map(([ver,p]) => ({ver, url:p.thumb_url}));
      }
      const src = r.source || (best.thumb_url?.startsWith('/thumbs/') ? 'cache' : 'drive');
      thumbCache[c.id] = {url:best.thumb_url, isVideo:allVideo, versions: versions && versions.length > 1 ? versions : null, src, ms, preloaded: false};
      if(el){ renderThumbEl(el, c.id, thumbCache[c.id]); if(adminModeVisible) showThumbMeta(c.id, ms, src); }
      _highPriorityIds.delete(c.id);
    } catch(e){
      thumbCache[c.id] = THUMB_RETRY;
      const el = document.getElementById('ct-'+c.id);
      if(el) el.innerHTML = '<div class="ct-error"><div class="sad">😔</div><span>retry</span></div>';
    } finally { sem.release(); }
  }));
  if(!stale()) updatePageTimer();
}
