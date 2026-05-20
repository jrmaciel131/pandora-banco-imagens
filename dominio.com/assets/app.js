/* Bootstrap da aplicação: inicializa filtros, carrega casos e verifica sessão.
   Carregado por último — todos os globais definidos pelos outros módulos
   precisam estar disponíveis antes deste arquivo rodar. */

async function initApp(preloadedCasos = null, preloadedProfs = null){
  populateEstados();
  loadCanonicalTags();
  if(preloadedCasos){
    /* Switch_base já trouxe os dados na própria resposta — evita request extra. */
    casos = preloadedCasos;
    allProfs = preloadedProfs || [];
    applyFilter();
    checkNewFiles();
  } else {
    await loadCasos();
    checkNewFiles();
  }
}

checkSessionOnLoad();

// Fase F — atalhos de teclado globais
document.addEventListener('keydown', e => {
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
              || document.activeElement?.isContentEditable;

  if(e.key === '?' && !typing){
    e.preventDefault();
    const sh = document.getElementById('s-shortcuts');
    if(sh) sh.style.display = sh.style.display === 'none' ? 'flex' : 'none';
    return;
  }

  if(e.key === 'Escape'){
    const sh = document.getElementById('s-shortcuts');
    if(sh && sh.style.display !== 'none'){ sh.style.display = 'none'; return; }
    if(document.getElementById('ov')?.classList.contains('open')){ closeModal(); return; }
    return;
  }

  if(typing) return;

  if(document.getElementById('ov')?.classList.contains('open')){
    if(e.key === 'ArrowLeft'  || e.key === 'k') modalNavStep(-1);
    if(e.key === 'ArrowRight' || e.key === 'j') modalNavStep(1);
  }
});

// Fase B — mobile filter drawer
document.getElementById('btn-mobile-filters')?.addEventListener('click', () =>
  document.getElementById('filters-rail').classList.toggle('s-open')
);
document.querySelector('.s-rail-close')?.addEventListener('click', () =>
  document.getElementById('filters-rail').classList.remove('s-open')
);

// Fase D — sticky stats ao rolar
window.addEventListener('scroll', () => {
  const ss = document.getElementById('s-sticky-stats');
  if(!ss) return;
  ss.classList.toggle('s-show', window.scrollY > 200);
  const sdEl = document.getElementById('sd');
  const ssSel = document.getElementById('s-ss-sel');
  const ssFil = document.getElementById('s-ss-filters');
  if(sdEl && document.getElementById('s-ss-disp'))
    document.getElementById('s-ss-disp').textContent = sdEl.textContent;
  if(ssSel && typeof selIds !== 'undefined') ssSel.textContent = selIds.size;
  if(ssFil) ssFil.textContent =
    [typeof selUF !== 'undefined' ? selUF : '',
     typeof selTags !== 'undefined' ? [...selTags].join(',') : '']
    .filter(Boolean).join(' · ') || 'sem filtros';
});
