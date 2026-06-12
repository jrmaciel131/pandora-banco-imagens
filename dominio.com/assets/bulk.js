/* Operações em lote (registro em massa, por ID, download ZIP) e lightbox flutuante. */

let selMode = false, selIds = new Set(), bulkSelIds = new Set();
let bulkCities = {ba:[], bi:[]};
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

function renderLightboxFlo(){
  const p = currentPhotos[_lfIdx];
  if(!p) return;
  const img = document.getElementById('lf-img');
  const info = document.getElementById('lf-info');
  img.alt = p.name || '';
  /* Marca a navegação atual para descartar carregamentos de imagens já trocadas. */
  const token = ++_lfLoadToken;
  /* Mostra a thumbnail imediatamente; para vídeos não há original exibível. */
  img.src = p.thumb_url || '';
  img.classList.remove('lf-loading');
  if(!p.isVideo && p.id){
    /* Busca o original do Drive sob demanda e troca quando estiver pronto. */
    img.classList.add('lf-loading');
    const full = new Image();
    full.onload = () => {
      if(token !== _lfLoadToken) return;
      img.src = full.src;
      img.classList.remove('lf-loading');
    };
    full.onerror = () => { if(token === _lfLoadToken) img.classList.remove('lf-loading'); };
    full.src = `${API}?action=view_photo&file_id=${encodeURIComponent(p.id)}`;
  }
  const tag = p.version_tag ? ` · ${p.version_tag}` : '';
  info.textContent = `${p.name || ''} (${_lfIdx+1}/${currentPhotos.length})${tag}`;
  document.getElementById('lf-prev').disabled = currentPhotos.length <= 1;
  document.getElementById('lf-next').disabled = currentPhotos.length <= 1;
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

function openBulkApply(){
  if(!selIds.size) return;
  document.getElementById('bai').textContent = `Aplicar para ${selIds.size} caso(s): ${[...selIds].join(', ')}`;
  document.getElementById('baerrs').style.display = 'none';
  document.getElementById('baerr').textContent = '';
  document.getElementById('bauf').innerHTML = '<option value="">Selecione...</option>';
  ESTADOS.forEach(e => document.getElementById('bauf').appendChild(new Option(`${e.s} – ${e.n}`, e.s)));
  const baci = document.getElementById('baci');
  baci.value = ''; baci.dataset.val = ''; baci.readOnly = true;
  document.getElementById('bapro').value = '';
  document.getElementById('baprosug').style.display = 'none';
  document.getElementById('bav').classList.add('open');
}

async function submitBulkApply(){
  const uf = document.getElementById('bauf').value;
  const city = (document.getElementById('baci').dataset.val || '').toUpperCase();
  const prof = document.getElementById('bapro').value.trim();

  if(!uf || !city || !prof){ document.getElementById('baerr').textContent = 'Preencha todos os campos.'; return; }
  if(!selIds.size){ document.getElementById('baerr').textContent = 'Nenhum caso selecionado.'; return; }

  const ids = [...selIds];
  const total = ids.length;

  /* Pré-flight ATÔMICO via backend (verifica cidade, bloqueio e distância). */
  const pre = await api('bulk_preflight', {ids:ids.join(','), uf, cidade:city, profissional:prof}, 'POST');
  if(!pre.ok){
    document.getElementById('baerr').textContent = pre.error || 'Erro na verificação prévia.';
    return;
  }
  if(pre.errors && pre.errors.length){
    document.getElementById('baerrs').innerHTML = '<div style="font-weight:700;margin-bottom:.4rem">Falhou na verificação prévia (' + pre.errors.length + ') — nada foi gravado:</div>' + pre.errors.map(e => '<div style="padding:2px 0">• '+esc(e)+'</div>').join('');
    document.getElementById('baerrs').style.display = 'block';
    document.getElementById('baerr').textContent = '';
    return;
  }
  if(pre.warns && pre.warns.length){
    const proceed = confirm('Atenção (' + pre.warns.length + ' aviso(s)):\n\n' + pre.warns.join('\n') + '\n\nDeseja continuar mesmo assim?');
    if(!proceed) return;
  }

  const modal = document.querySelector('#bav .modal');
  modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
    <div style="margin-bottom:1.25rem"><span class="spin" style="width:32px;height:32px;border-width:3px"></span></div>
    <div style="font-size:15px;font-weight:600;margin-bottom:.5rem">Registrando usos...</div>
    <div style="font-size:13px;color:var(--tx2);margin-bottom:.5rem" id="ba-progress">0 de ${total} processados</div>
    <div style="width:100%;max-width:240px;margin:0 auto;height:4px;background:var(--bd);border-radius:2px;overflow:hidden">
      <div id="ba-bar" style="height:100%;background:var(--accent);width:0%;transition:width .2s;border-radius:2px"></div>
    </div>
  </div>`;

  const errors = [];
  let done = 0;
  for(const id of ids){
    const caso = casos.find(c => c.id === id);
    if(!caso){ errors.push(`${id}: não encontrado na planilha`); done++; }
    else {
      try{
        const r = await api('add_uso', {caso_id:id, row:caso.row, uf, cidade:city, profissional:prof, force:'1'}, 'POST');
        if(!r.ok && !r.warn) errors.push(`${id}: ${r.error||'erro desconhecido'}`);
      } catch(e){ errors.push(`${id}: falha de conexão`); }
      done++;
    }
    const prog = document.getElementById('ba-progress');
    const bar = document.getElementById('ba-bar');
    if(prog) prog.textContent = `${done} de ${total} processados`;
    if(bar) bar.style.width = `${Math.round(done/total*100)}%`;
  }

  await loadCasos(true);
  const ok = total - errors.length;

  if(errors.length){
    modal.innerHTML = `<div style="padding:2rem 1.5rem">
      <div style="font-size:2rem;text-align:center;margin-bottom:.75rem">${ok>0?'⚠️':'❌'}</div>
      <div style="font-size:15px;font-weight:700;text-align:center;margin-bottom:1rem;color:${ok>0?'var(--atx)':'var(--rtx)'}">
        ${ok>0?`${ok} registrados, ${errors.length} com erro`:'Falha ao registrar'}
      </div>
      ${ok>0?`<div style="font-size:12px;color:var(--tx2);text-align:center;margin-bottom:.75rem">Estado: <b>${esc(uf)}</b> · Cidade: <b>${esc(cap(city))}</b> · Profissional: <b>${esc(prof)}</b></div>`:''}
      <div style="background:var(--rbg);border:1px solid var(--rtx);border-radius:var(--rs);padding:.75rem;font-size:12px;color:var(--rtx);max-height:180px;overflow-y:auto;margin-bottom:1rem">
        <div style="font-weight:700;margin-bottom:.4rem">Erros (${errors.length}):</div>
        ${errors.map(e => `<div style="padding:2px 0">• ${esc(e)}</div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn bp" onclick="document.getElementById('bav').classList.remove('open');clearSel()">Fechar</button>
        <button class="btn bs" onclick="document.getElementById('bav').classList.remove('open')">Manter seleção</button>
      </div>
    </div>`;
  } else {
    modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
      <div style="font-size:16px;font-weight:700;color:var(--gtx);margin-bottom:.75rem">${ok} caso(s) registrados com sucesso!</div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:.25rem">Estado: <b>${esc(uf)}</b></div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:.25rem">Cidade: <b>${esc(cap(city))}</b></div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:1.25rem">Profissional: <b>${esc(prof)}</b></div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;justify-content:center;margin-bottom:1.5rem;max-height:120px;overflow-y:auto">
        ${ids.map(id => `<span style="padding:2px 8px;background:var(--gbg);color:var(--gtx);border-radius:10px;font-size:11px">${esc(id)}</span>`).join('')}
      </div>
      <button class="btn bp" onclick="document.getElementById('bav').classList.remove('open');clearSel()" style="margin:0 auto">Concluir</button>
    </div>`;
    bulkSelIds = new Set();
  }
}

function openBulkModal(){
  document.getElementById('biinp').value = '';
  document.getElementById('bierr').textContent = '';
  document.getElementById('bigrid').innerHTML = '';
  document.getElementById('biform').style.display = 'none';
  document.getElementById('biuf').innerHTML = '<option value="">Selecione...</option>';
  ESTADOS.forEach(e => document.getElementById('biuf').appendChild(new Option(`${e.s} – ${e.n}`, e.s)));
  const bici = document.getElementById('bici');
  bici.value = ''; bici.dataset.val = ''; bici.readOnly = true;
  document.getElementById('bipro').value = '';
  document.getElementById('biprosug').style.display = 'none';
  document.getElementById('bierrs').style.display = 'none';
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

async function submitBulkById(){
  const uf = document.getElementById('biuf').value;
  const city = (document.getElementById('bici').dataset.val || '').toUpperCase();
  const prof = document.getElementById('bipro').value.trim();
  document.getElementById('bierrs').style.display = 'none';

  if(!bulkSelIds.size){ document.getElementById('bierr2').textContent = 'Nenhum caso selecionado.'; return; }

  const ids = [...bulkSelIds];
  const total = ids.length;

  /* Pré-flight ATÔMICO via backend (cidade-block + distância + bloqueio). */
  const pre = await api('bulk_preflight', {ids:ids.join(','), uf, cidade:city, profissional:prof}, 'POST');
  if(!pre.ok){
    document.getElementById('bierr2').textContent = pre.error || 'Erro na verificação prévia.';
    return;
  }
  if(pre.errors && pre.errors.length){
    document.getElementById('bierrs').innerHTML = '<div style="font-weight:700;margin-bottom:.4rem">Falhou na verificação prévia (' + pre.errors.length + ') — nada foi gravado:</div>' + pre.errors.map(e => '<div style="padding:2px 0">• '+esc(e)+'</div>').join('');
    document.getElementById('bierrs').style.display = 'block';
    document.getElementById('bierr2').textContent = '';
    return;
  }
  if(pre.warns && pre.warns.length){
    const proceed = confirm('Atenção (' + pre.warns.length + ' aviso(s)):\n\n' + pre.warns.join('\n') + '\n\nDeseja continuar mesmo assim?');
    if(!proceed) return;
  }

  const modal = document.querySelector('#biv .modal');
  modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
    <div style="margin-bottom:1.25rem"><span class="spin" style="width:32px;height:32px;border-width:3px"></span></div>
    <div style="font-size:15px;font-weight:600;margin-bottom:.5rem">Registrando usos...</div>
    <div style="font-size:13px;color:var(--tx2)" id="bi-progress">0 de ${total} processados</div>
  </div>`;

  const errors = [];
  let done = 0;
  for(const id of ids){
    const caso = casos.find(c => c.id === id);
    if(!caso){ errors.push(`${id}: não encontrado`); done++; continue; }
    try{
      const r = await api('add_uso', {caso_id:id, row:caso.row, uf, cidade:city, profissional:prof, force:'1'}, 'POST');
      if(!r.ok && !r.warn) errors.push(`${id}: ${r.error||'erro'}`);
    } catch(e){ errors.push(`${id}: conexão`); }
    done++;
    const prog = document.getElementById('bi-progress');
    if(prog) prog.textContent = `${done} de ${total} processados`;
  }
  await loadCasos(true);

  const ok = total - errors.length;
  if(errors.length){
    modal.innerHTML = `<div style="padding:2rem 1.5rem">
      <div style="font-size:1.75rem;text-align:center;margin-bottom:.75rem">${ok>0?'⚠️':'❌'}</div>
      <div style="font-size:15px;font-weight:700;text-align:center;margin-bottom:1rem;color:var(--rtx)">${ok>0?`${ok} registrados, ${errors.length} com erro`:'Falha no registro'}</div>
      <div style="background:var(--rbg);border-radius:var(--rs);padding:.75rem;font-size:12px;color:var(--rtx);max-height:150px;overflow-y:auto;margin-bottom:1rem">
        ${errors.map(e => `<div>• ${esc(e)}</div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn bp" onclick="document.getElementById('biv').classList.remove('open')">Fechar</button>
      </div>
    </div>`;
  } else {
    modal.innerHTML = `<div style="padding:3rem 2rem;text-align:center">
      <div style="font-size:2.5rem;margin-bottom:.75rem">✅</div>
      <div style="font-size:16px;font-weight:700;color:var(--gtx);margin-bottom:.5rem">${ok} caso(s) registrados com sucesso!</div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:.35rem">Estado: <b>${esc(uf)}</b></div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:.35rem">Cidade: <b>${esc(cap(city))}</b></div>
      <div style="font-size:13px;color:var(--tx2);margin-bottom:1.5rem">Profissional: <b>${esc(prof)}</b></div>
      <div style="font-size:12px;color:var(--tx3);margin-bottom:1.5rem">${ids.map(id => `<span style="display:inline-block;padding:2px 8px;background:var(--gbg);color:var(--gtx);border-radius:10px;font-size:11px;margin:2px">${esc(id)}</span>`).join('')}</div>
      <button class="btn bp" onclick="document.getElementById('biv').classList.remove('open')" style="margin:0 auto">Concluir</button>
    </div>`;
    bulkSelIds = new Set();
  }
}

async function onBulkUF(t){
  const si = t === 'ba' ? 'bauf' : 'biuf';
  const ci = t === 'ba' ? 'baci' : 'bici';
  const uf = document.getElementById(si).value;
  const el = document.getElementById(ci);
  el.value = ''; el.dataset.val = '';
  bulkCities[t] = [];
  el.readOnly = true;
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
  });
}

function openBulkCityDD(t){
  const ci = t === 'ba' ? 'baci' : 'bici';
  if(!document.getElementById(ci).readOnly) onBulkCityInp(t);
}

function onBulkProf(t){
  if(t === 'ba') buildProfAC('bapro', 'baprodd', 'baprosug');
  else           buildProfAC('bipro', 'biprodd', 'biprosug');
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
    if(typeof applyFilter === 'function') applyFilter();

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
