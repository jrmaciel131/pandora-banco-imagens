/* ─────────────────────────────────────────────────────────────────
   fit-numbers.js — ajuste por célula (como o Canva): cada número fica no
   tamanho de design e só encolhe se não couber na própria coluna numa
   linha. Números curtos ("132", "73K") ficam grandes; valores longos
   ("R$ 2.041,84") encolhem o suficiente pra caber — igual à referência.
   Valores absurdos (ex: "R$ 123.456,78") param no piso e quebram em 2
   linhas em vez de transbordar e cortar.

   Também cuida da DISTRIBUIÇÃO dos KPIs da Visão Geral (.kpi-grid.vg-flex):
   distribui em no máximo 2 linhas (nunca 3) calculando a largura de cada
   coluna pela quantidade de KPIs, e padroniza a fonte das legendas (.kpi-l)
   para que todas fiquem do MESMO tamanho e nenhuma passe de 2 linhas.

   Chame window.__fitNumbers() depois de popular os data-field.
   ───────────────────────────────────────────────────────────────── */
(function () {
  const TARGETS = [
    '.kpi-n',        // visão geral + campanhas (76px de design)
    '.set-cell .n',  // conjuntos (60px de design)
  ];
  const MIN_FRAC = 0.40;  // não encolhe além de 40% do tamanho de design

  function baseOf(el) {
    let b = parseFloat(el.dataset.baseFs);
    if (!b) { b = parseFloat(getComputedStyle(el).fontSize); el.dataset.baseFs = b; }
    return b;
  }

  function fitOne(el) {
    const avail = el.parentElement.clientWidth;
    if (!avail) return;

    const base = baseOf(el);
    el.style.whiteSpace = 'nowrap';
    el.style.fontSize = base + 'px';

    const minSize = base * MIN_FRAC;
    let size = base;
    let guard = 0;
    while (el.scrollWidth > avail + 0.5 && size > minSize && guard < 80) {
      size -= 1;
      el.style.fontSize = size + 'px';
      guard++;
    }

    // valor extremo: nem no piso cabe numa linha → deixa quebrar (cresce
    // na vertical, onde há folga) em vez de transbordar a coluna.
    el.style.whiteSpace = el.scrollWidth > avail + 0.5 ? 'normal' : 'nowrap';
  }

  // ── distribuição da Visão Geral: no MÁXIMO 2 linhas ────────────────
  // Calcula quantas colunas usar (a partir da contagem de KPIs) e fixa a
  // largura de cada célula pela largura disponível, ocupando bem a tela.
  const COL_GAP = 40;            // espaço horizontal entre KPIs
  const KPI_MIN = 150, KPI_MAX = 300;  // limites de largura por célula
  function layoutVgGrid(grid) {
    const kids = [].slice.call(grid.querySelectorAll(':scope > .kpi'));
    const n = kids.length;
    if (!n) return;
    const avail = grid.clientWidth;
    if (!avail) return;
    // até 5 KPIs cabem confortavelmente em 1 linha (padrão do Canva);
    // a partir de 6, divide em 2 linhas equilibradas.
    const rows = n <= 5 ? 1 : 2;
    const cols = Math.ceil(n / rows);
    let basis = Math.floor((avail - (cols - 1) * COL_GAP) / cols);
    basis = Math.max(KPI_MIN, Math.min(KPI_MAX, basis));
    kids.forEach((k) => { k.style.flex = '0 0 ' + basis + 'px'; k.style.maxWidth = basis + 'px'; });
  }

  // ── legendas padronizadas: mesma fonte p/ todas, máx. 2 linhas ─────
  // Acha o maior tamanho (≤ design) em que NENHUMA legenda do grupo passe
  // de 2 linhas e aplica esse tamanho a todas (não varia entre KPIs).
  function fitLabelsUniform(container) {
    const labels = [].slice.call(container.querySelectorAll('.kpi-l'));
    if (!labels.length) return;
    const base = baseOf(labels[0]);
    const min = Math.round(base * 0.6);
    labels.forEach((l) => { l.style.whiteSpace = 'normal'; });
    const overflowsAny = (s) => labels.some((l) => {
      l.style.fontSize = s + 'px';
      let lh = parseFloat(getComputedStyle(l).lineHeight);
      if (!lh || isNaN(lh)) lh = s * 1.2;
      return l.scrollHeight > lh * 2 + 1;
    });
    let size = base, guard = 0;
    while (overflowsAny(size) && size > min && guard < 40) { size -= 1; guard++; }
    labels.forEach((l) => { l.style.fontSize = size + 'px'; });
  }

  // ── títulos longos (conjunto com "nome inteiro", campanha extensa) ──
  // O .title-chip tem fonte grande e fixa; nomes longos transbordavam a página.
  // Aqui ele encolhe só o necessário pra caber na largura, até um piso; se nem
  // assim couber numa linha, deixa quebrar (2+ linhas) em vez de cortar.
  function fitTitleChips() {
    document.querySelectorAll('#deck .title-chip').forEach((el) => {
      const row = el.parentElement; if (!row) return;
      const avail = row.clientWidth; if (!avail) return;
      let base = parseFloat(el.dataset.baseFs);
      if (!base) { base = parseFloat(getComputedStyle(el).fontSize); el.dataset.baseFs = base; }
      el.style.whiteSpace = 'nowrap';
      el.style.fontSize = base + 'px';
      const min = Math.max(16, base * 0.42);
      let size = base, guard = 0;
      while (el.scrollWidth > avail + 0.5 && size > min && guard < 90) { size -= 1; el.style.fontSize = size + 'px'; guard++; }
      el.style.whiteSpace = el.scrollWidth > avail + 0.5 ? 'normal' : 'nowrap';
    });
  }

  function fitAll() {
    // 1) distribui os KPIs da Visão Geral em no máx. 2 linhas (define a
    //    largura de cada coluna ANTES de ajustar números/legendas).
    document.querySelectorAll('.kpi-grid.vg-flex').forEach(layoutVgGrid);
    // 2) ajusta os NÚMEROS (.kpi-n / .set-cell .n) por célula.
    TARGETS.forEach((sel) => document.querySelectorAll(sel).forEach(fitOne));
    // 3) padroniza as LEGENDAS da Visão Geral (mesmo tamanho, máx. 2 linhas).
    document.querySelectorAll('.kpi-grid.vg-flex').forEach(fitLabelsUniform);
    // 4) encolhe títulos (.title-chip) que não couberem na largura da página.
    fitTitleChips();
  }

  window.__fitNumbers = fitAll;

  window.addEventListener('load', () => setTimeout(fitAll, 300));
  if (document.fonts) document.fonts.ready.then(() => setTimeout(fitAll, 120));
})();
