/* ─────────────────────────────────────────────────────────────────
   report-render.js — gera o deck dinamicamente a partir do discover()
   do report-parser.js. Mesma estrutura repetindo blocos: capa, objetivos,
   visão geral, e por campanha {resumo, gráfico top5, lista de criativos},
   por conjunto {resumo, gráfico, lista}. Suporta N campanhas/conjuntos,
   ocultar e mesclar conjuntos.
   ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── formatação BR (espelha o report-parser) ──────────────────────
  const div = (a, b) => (b ? a / b : NaN);
  const fmtInt = (n) => Math.round(n).toLocaleString('pt-BR');
  const fmtK = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : fmtInt(n));
  const fmtCur = (n) => (isFinite(n) ? 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'NA');
  const fmtPct = (r) => (isFinite(r) ? (r * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' : 'NA');
  const fmtDec = (n) => (isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'NA');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  // tradução de valores de dimensão (idade/gênero) para PT
  const DIM_PT = { unknown: 'Desconhecido', desconhecido: 'Desconhecido', 'n/a': 'Desconhecido', na: 'Desconhecido', male: 'Masculino', female: 'Feminino', men: 'Masculino', women: 'Feminino', all: 'Todos' };
  // grafia canônica de plataformas/posicionamentos (o Meta exporta em minúsculo)
  const PLAT_PT = { instagram: 'Instagram', facebook: 'Facebook', audience_network: 'Audience Network', 'audience network': 'Audience Network', messenger: 'Messenger', whatsapp: 'WhatsApp', threads: 'Threads' };
  // corrige a CAIXA de nomes de marca onde aparecerem em qualquer texto
  // (ex.: "instagram" digitado em minúsculo no nome do conjunto/anúncio →
  // "Instagram"). Troca só palavras inteiras, preservando o resto do texto.
  const BRANDS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['threads', 'Threads'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn'], ['pinterest', 'Pinterest'], ['google', 'Google']];
  const BRAND_MAP = BRANDS.reduce((o, b) => { o[b[0]] = b[1]; return o; }, {});
  const BRAND_RE = new RegExp('\\b(' + BRANDS.map((b) => b[0]).join('|') + ')\\b', 'gi');
  const fixBrands = (s) => String(s == null ? '' : s).replace(BRAND_RE, (m) => BRAND_MAP[m.toLowerCase()] || m);
  const trDim = (k) => { const key = String(k).toLowerCase().trim(); return DIM_PT[key] || PLAT_PT[key] || fixBrands(String(k)); };
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = String(html).trim(); return t.content.firstElementChild; };

  // rótulos automáticos (editáveis depois no site)
  const labelCampaign = (name) => esc(String(name).replace(/[\[\]]/g, '').replace(/-/g, ' ').trim().toUpperCase() || 'CAMPANHA');
  // nome do conjunto RESUMIDO (padrão): prefixo numérico (ex.: "3.1") ou os
  // primeiros caracteres do nome; corrige a caixa de marcas.
  const labelConj = (name) => { const m = String(name).match(/^([0-9.]+)/); return 'CONJUNTO ' + fixBrands(m ? m[1] : String(name).trim().slice(0, 12)); };
  // nome do conjunto INTEIRO: nome completo (espaços normalizados + marcas).
  const cleanConjName = (name) => fixBrands(String(name == null ? '' : name).replace(/\s+/g, ' ').trim()) || 'Conjunto';
  // rótulo do conjunto conforme o modo escolhido em Configurações (resumido x
  // inteiro). refs pode ter >1 adset (conjuntos mesclados).
  function conjLabel(refs) {
    const names = (refs || []).map((r) => r.name);
    if (CONFIG && CONFIG.fullConjNames) return 'CONJUNTO ' + names.map(cleanConjName).join(' + ');
    return names.length <= 1 ? labelConj(names[0] || '') : 'CONJUNTO ' + names.map((n) => labelConj(n).replace(/^CONJUNTO\s*/i, '')).join(' + ');
  }
  // sigla da campanha p/ prefixar o conjunto: 1ª tag entre colchetes mantendo o
  // hífen (ex.: "[TF-IG]-[R12K]-..." → "TF-IG"); sem colchetes, usa a 1ª palavra.
  const campTag = (name) => {
    const s = String(name == null ? '' : name);
    const m = s.match(/\[([^\]]+)\]/);
    const raw = m ? m[1] : s.replace(/[\[\]]/g, ' ').trim().split(/\s+/)[0];
    return (raw || 'CAMPANHA').trim().toUpperCase();
  };
  // rótulo exibido do conjunto = "TAG-DA-CAMPANHA | NOME DO CONJUNTO"
  const dispConj = (cc, cj) => campTag(cc.ref.name) + ' | ' + cj.label;
  const shortRes = (rt) => esc((rt || 'Resultado').split(' ').slice(0, 2).join(' '));

  // Versão do código (mostrada no menu). Bump a cada deploy — se o número no
  // menu não mudar depois de subir os arquivos, é cache (atualize com Ctrl+F5).
  const APP_VERSION = '2026.06.08-4';

  let DISCOVERED = null, CONFIG = null, editing = true, PLATFORM_DATA = null;

  // ── mescla de conjuntos (1 ou vários adsets viram 1 bloco) ────────
  function mergeDim(refs, dim) {
    const m = new Map();
    refs.forEach((a) => (a.breakdown && a.breakdown[dim] || []).forEach((o) => {
      const g = m.get(o.key) || { spend: 0, results: 0 }; g.spend += o.spend; g.results += o.results; m.set(o.key, g);
    }));
    return [...m.entries()].map(([key, v]) => ({ key, spend: v.spend, results: v.results }));
  }
  // desempate de anúncios (espelha o parser): resultados desc, depois MENOR gasto, depois nome.
  // Entradas do mapa: [nome, { res, spend }]. O adsList do parser vem como [nome, res, spend].
  function cmpAdEntry(x, y) { return (y[1].res - x[1].res) || (x[1].spend - y[1].spend) || String(x[0]).localeCompare(String(y[0])); }
  function mergeAdsets(refs) {
    const breakdown = { age: mergeDim(refs, 'age'), gender: mergeDim(refs, 'gender'), platform: mergeDim(refs, 'platform') };
    if (refs.length === 1) { const a = refs[0]; return { metrics: a.metrics, top5: a.top5, breakdown: a.breakdown || breakdown }; }
    const s = { results: 0, spend: 0, impressions: 0, reach: 0, clicks: 0 };
    const adMap = new Map();
    refs.forEach((a) => {
      s.results += a.raw.results; s.spend += a.raw.spend; s.impressions += a.raw.impressions;
      s.reach += a.raw.reach; s.clicks += a.raw.clicks;
      (a.adsList || []).forEach(([n, r, sp]) => { const g = adMap.get(n) || { res: 0, spend: 0 }; g.res += r; g.spend += (sp || 0); adMap.set(n, g); });
    });
    const top5 = [...adMap.entries()].sort(cmpAdEntry).slice(0, 5).map(([n, v]) => ({ name: n, results: Math.round(v.res) }));
    return { metrics: { results: s.results, spend: s.spend, impressions: s.impressions, reach: s.reach, clicks: s.clicks, ads: adMap.size, cpr: div(s.spend, s.results) }, top5, breakdown };
  }

  // ── config inicial a partir do discover ───────────────────────────
  function buildConfig(d) {
    return {
      cover: { title1: 'RELATÓRIO', title2: 'DE RESULTADOS' },
      introText: 'Os resultados aqui apresentados fornecem insights valiosos para aprimorar as estratégias de marketing digital e posicionamento.',
      objetivos: ['Aumentar o tráfego no Meta', 'Gerar novos leads'],
      reachOverall: null, // alcance real (único) da conta, digitado do painel da Meta
      followers: null,    // seguidores ganhos no período (manual; não vem no export de anúncios)
      fullConjNames: false, // false = nome do conjunto resumido (padrão); true = nome inteiro
      hidden: [], // chaves (data-hkey) de dados individuais ocultados
      hiddenKinds: [], // tipos de KPI ocultos em TODO o relatório (data-kind)
      brkMetric: { age: 'spend', gender: 'spend', platform: 'spend' }, // métrica global do detalhamento
      campaigns: d.campaigns.map((c) => ({
        ref: c, label: labelCampaign(c.name), include: true, showChart: false,
        reachReal: null, // alcance real (único) da campanha
        conjuntos: c.adsets.map((a) => ({ refs: [a], label: labelConj(a.name), labelAuto: true, include: true })),
      })),
    };
  }

  // ── persistência das EDIÇÕES (sem os dados do Excel) ──────────────
  // Serializa só o que o usuário ajustou (rótulos, mescla, ocultos, Top5,
  // objetivos, alcance, seguidores). Conjuntos são guardados pelos NOMES dos
  // adsets, para re-casar com o Excel ao restaurar/importar. Usado tanto pela
  // persistência automática (cache curto) quanto pelo Exportar/Importar perfil.
  function serializeConfig(cfg) {
    if (!cfg) return null;
    return {
      v: 1, kind: 'v1',
      cover: cfg.cover, introText: cfg.introText, objetivos: cfg.objetivos,
      reachOverall: cfg.reachOverall, followers: cfg.followers,
      fullConjNames: cfg.fullConjNames, brkMetric: cfg.brkMetric,
      hidden: cfg.hidden, hiddenKinds: cfg.hiddenKinds,
      campaigns: (cfg.campaigns || []).map((cc) => ({
        name: cc.ref.name, label: cc.label, include: cc.include, showChart: cc.showChart, reachReal: cc.reachReal,
        conjuntos: (cc.conjuntos || []).map((cj) => ({
          adsets: cj.refs.map((r) => r.name), label: cj.label, labelAuto: cj.labelAuto, include: cj.include,
          top5Override: cj.top5Override || null, exclAds: cj.exclAds || null,
        })),
      })),
    };
  }
  // Remonta o CONFIG a partir de um snapshot + o discover atual, casando por
  // NOME (campanha → adsets). Campanhas/conjuntos novos no Excel entram ao fim;
  // os que sumiram são ignorados.
  function applyConfigSnapshot(snap, d) {
    const base = buildConfig(d);
    if (!snap || snap.kind !== 'v1') return base;
    if (snap.cover) base.cover = Object.assign({}, base.cover, snap.cover);
    if (snap.introText != null) base.introText = snap.introText;
    if (Array.isArray(snap.objetivos)) base.objetivos = snap.objetivos.slice();
    if ('reachOverall' in snap) base.reachOverall = snap.reachOverall;
    if ('followers' in snap) base.followers = snap.followers;
    if ('fullConjNames' in snap) base.fullConjNames = !!snap.fullConjNames;
    if (snap.brkMetric) base.brkMetric = Object.assign({}, base.brkMetric, snap.brkMetric);
    if (Array.isArray(snap.hidden)) base.hidden = snap.hidden.slice();
    if (Array.isArray(snap.hiddenKinds)) base.hiddenKinds = snap.hiddenKinds.slice();
    const byName = new Map(base.campaigns.map((c) => [c.ref.name, c]));
    const used = new Set(), ordered = [];
    (snap.campaigns || []).forEach((sc) => {
      const cc = byName.get(sc.name); if (!cc) return;
      used.add(sc.name);
      if (sc.label != null) cc.label = sc.label;
      cc.include = sc.include !== false;
      cc.showChart = !!sc.showChart;
      cc.reachReal = (sc.reachReal != null) ? sc.reachReal : null;
      const adsetByName = new Map(cc.ref.adsets.map((a) => [a.name, a]));
      const usedAdsets = new Set(), conjuntos = [];
      (sc.conjuntos || []).forEach((sj) => {
        const refs = (sj.adsets || []).map((n) => adsetByName.get(n)).filter(Boolean);
        if (!refs.length) return;
        refs.forEach((r) => usedAdsets.add(r.name));
        const cj = { refs, label: sj.label, labelAuto: sj.labelAuto !== false, include: sj.include !== false };
        if (sj.top5Override) cj.top5Override = sj.top5Override;
        if (sj.exclAds) cj.exclAds = sj.exclAds;
        conjuntos.push(cj);
      });
      cc.ref.adsets.forEach((a) => { if (!usedAdsets.has(a.name)) conjuntos.push({ refs: [a], label: labelConj(a.name), labelAuto: true, include: true }); });
      if (conjuntos.length) cc.conjuntos = conjuntos;
      ordered.push(cc);
    });
    base.campaigns.forEach((cc) => { if (!used.has(cc.ref.name)) ordered.push(cc); });
    base.campaigns = ordered;
    return base;
  }
  // cache curto no navegador (2h desde a última edição), por relatório (namespace).
  const CFG_TTL_MS = 2 * 60 * 60 * 1000;
  let _cfgSaveT = null;
  function saveConfigSoon() {
    if (!CONFIG || !window.__imgPersist) return;
    clearTimeout(_cfgSaveT);
    _cfgSaveT = setTimeout(() => {
      try { window.__imgPersist.putKV('reportCfgV1', { savedAt: Date.now(), snap: serializeConfig(CONFIG) }); } catch (e) {}
    }, 1000);
  }
  // Pergunta se deve restaurar ajustes salvos < 2h (só quando há edições reais).
  async function maybeRestoreConfig(d) {
    if (!window.__imgPersist) return null;
    try {
      const saved = await window.__imgPersist.getKV('reportCfgV1');
      if (!saved || !saved.snap || (Date.now() - saved.savedAt) >= CFG_TTL_MS) return null;
      const def = JSON.stringify(serializeConfig(buildConfig(d)));
      if (JSON.stringify(saved.snap) === def) return null; // nada editado
      const mins = Math.max(1, Math.round((Date.now() - saved.savedAt) / 60000));
      if (window.confirm('Encontrei ajustes deste relatório salvos há ~' + mins + ' min. Restaurar a última versão?\n\n(Cancelar = começar do zero.)')) {
        return applyConfigSnapshot(saved.snap, d);
      }
    } catch (e) {}
    return null;
  }
  // Exportar/Importar perfil (.json) — botões no painel "Configurações".
  function exportConfig() {
    const snap = serializeConfig(CONFIG); if (!snap) return;
    const tag = (DISCOVERED && DISCOVERED.period) ? (DISCOVERED.period.month + '-' + DISCOVERED.period.year) : 'v1';
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'relatorio-config-' + tag + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function importConfigPrompt() {
    if (!DISCOVERED) return;
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/json,.json';
    inp.onchange = () => {
      const f = inp.files && inp.files[0]; if (!f) return;
      const r = new FileReader();
      r.onload = () => {
        let snap = null;
        try { snap = JSON.parse(r.result); } catch (e) {}
        if (!snap || snap.kind !== 'v1') { alert('Arquivo de configuração inválido (esperado um perfil da V1).'); return; }
        CONFIG = applyConfigSnapshot(snap, DISCOVERED);
        const bd = document.getElementById('cfg-backdrop'); if (bd) bd.remove();
        render();
        const st = document.getElementById('rt-status'); if (st) st.textContent = 'Configuração importada do arquivo.';
      };
      r.readAsText(f);
    };
    inp.click();
  }

  // ── blocos (cada função retorna um <section>) ─────────────────────
  const kpiCell = (n, l, hkey, kind) => '<div class="kpi"' + (hkey ? ' data-hkey="' + esc(hkey) + '"' : '') + (kind ? ' data-kind="' + esc(kind) + '"' : '') + '>' +
    (hkey ? '<button class="kpi-hide" data-hide="' + esc(hkey) + '" title="Ocultar este dado" type="button">×</button>' : '') +
    '<span class="kpi-n ed">' + n + '</span><span class="kpi-l ed">' + l + '</span></div>';

  function buildCover() {
    const p = DISCOVERED.period;
    return el(
      '<section data-screen-label="Capa"><div class="cover">' +
        '<div class="bg-rockets"></div>' +
        '<div class="title-left"><div class="ed">' + esc(CONFIG.cover.title1) + '</div><div class="ed">' + esc(CONFIG.cover.title2) + '</div></div>' +
        '<div class="when"><span class="ed">' + esc(p.month) + '</span> - <span class="ed">' + esc(p.year) + '</span></div>' +
      '</div></section>');
  }

  function buildObjetivos() {
    const objs = CONFIG.objetivos.map((t, i) =>
      '<div class="obj-box"><div class="icon"><svg><use href="#' + (i === 0 ? 'ico-people' : 'ico-marketing') + '"/></svg></div>' +
      '<div class="text ed">' + esc(t) + '</div><div class="num">' + (i + 1) + '</div></div>').join('');
    return el(
      '<section data-screen-label="Objetivos"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="obj-grid"><div class="obj-stack">' + objs + '</div>' +
        '<div class="obj-side"><h2 class="ed">OBJETIVOS</h2><p class="ed">' + esc(CONFIG.introText) + '</p></div></div></div></section>');
  }

  function buildVisaoGeral() {
    // total = soma apenas das campanhas INCLUÍDAS (ocultar atualiza a Visão Geral)
    const inc = CONFIG.campaigns.filter((c) => c.include);
    const o = inc.reduce((a, c) => {
      const m = c.ref.metrics;
      a.spend += m.spend; a.impressions += m.impressions; a.clicks += m.clicks; a.reach += (c.reachReal != null ? c.reachReal : m.reach); a.results += m.results; a.followers += (m.followers || 0);
      return a;
    }, { spend: 0, impressions: 0, clicks: 0, reach: 0, results: 0, followers: 0 });
    const reach = (CONFIG.reachOverall != null) ? CONFIG.reachOverall : o.reach;
    let cells = kpiCell(fmtK(reach), 'Alcance', 'vg:alcance', 'alcance') + kpiCell(fmtK(o.impressions), 'Impressões', 'vg:impressoes', 'impressoes') +
      kpiCell(fmtK(o.clicks), 'Cliques no Link', 'vg:cliques', 'cliques') + kpiCell(fmtCur(div(o.spend, o.clicks)), 'CPC', 'vg:cpc', 'cpc') +
      kpiCell(fmtPct(div(o.clicks, o.impressions)), 'CTR', 'vg:ctr', 'ctr') + kpiCell(fmtDec(div(o.impressions, reach)), 'Frequência', 'vg:freq', 'frequencia');
    // Agrupa por TIPO DE RESULTADO (escala para N campanhas, sem rótulos
    // repetidos): 1 KPI de total + 1 de custo por tipo de resultado.
    const byType = new Map();
    CONFIG.campaigns.filter((c) => c.include).forEach((c) => {
      const rt = c.ref.resultType || 'Resultados';
      const g = byType.get(rt) || { results: 0, spend: 0 };
      g.results += c.ref.metrics.results; g.spend += c.ref.metrics.spend;
      byType.set(rt, g);
    });
    byType.forEach((g, rt) => {
      cells += kpiCell(fmtInt(g.results), esc(rt), 'vg:res:' + rt, 'resultados') + kpiCell(fmtCur(div(g.spend, g.results)), 'Custo por ' + esc(rt), 'vg:cpr:' + rt, 'custo_resultado');
    });
    cells += kpiCell(fmtCur(o.spend), 'Valor usado', 'vg:valor', 'valor');
    // Seguidores: lido do export ("Seguidores no Instagram"); editável à mão em
    // Configurações (CONFIG.followers tem precedência). Só vira KPI se houver valor.
    const fol = (CONFIG.followers != null) ? CONFIG.followers : (o.followers || 0);
    if (fol) cells += kpiCell(fmtInt(fol), 'Seguidores', 'vg:seguidores', 'seguidores');
    return el(
      '<section data-screen-label="Visão Geral"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="title-row"><h2 class="title-chip ed">VISÃO GERAL DOS RESULTADOS</h2></div>' +
        '<div class="inner-frame"><div class="kpi-grid vg-flex" style="margin:auto 0">' + cells + '</div>' +
        '<div class="kpi-divider"></div></div></div></section>');
  }

  function buildCampanha(cc) {
    const m = cc.ref.metrics;
    const reach = (cc.reachReal != null) ? cc.reachReal : m.reach;
    const k = 'camp:' + cc.ref.name + ':';
    const kp = kpiCell(fmtInt(m.results), 'Resultados', k + 'res', 'resultados') + kpiCell(fmtK(reach), 'Alcance', k + 'alc', 'alcance') +
      kpiCell(fmtK(m.impressions), 'Impressões', k + 'impr', 'impressoes') + kpiCell(fmtCur(m.cpr), 'Custo por resultado', k + 'cpr', 'custo_resultado') +
      kpiCell(fmtCur(m.spend), 'Valor usado', k + 'valor', 'valor');
    return el(
      '<section data-screen-label="Campanha ' + cc.label + '"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="title-row"><h2 class="title-chip lg ed">RESULTADOS DA CAMPANHA - ' + cc.label + '</h2></div>' +
        '<div class="inner-frame"><div class="camp"><div class="kpis">' + kp + '</div><div class="divider-top"></div></div></div>' +
        '<div class="camp-foot ed" style="text-align:center;font-size:26px;color:#fff;margin-top:24px">Aqui, podemos observar os principais resultados desta campanha.</div></div></section>');
  }

  function buildChart(top5, id, label) {
    // data-* em aspas duplas + esc() na JSON: nomes com apóstrofo (ex.: "D'Água")
    // não quebram mais o atributo (o ' fechava o data-labels e zerava o gráfico).
    // fixBrands corrige a caixa de marcas (ex.: "instagram" → "Instagram").
    const labels = esc(JSON.stringify(top5.map((x) => fixBrands(x.name))));
    const values = esc(JSON.stringify(top5.map((x) => x.results)));
    return el(
      '<section data-screen-label="Top5 ' + esc(label) + '"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="chart-page"><h2 class="title-chip sm ed">ANÚNCIOS</h2>' +
        '<div class="chart-legend" data-legend-for="' + id + '"></div>' +
        '<div class="chart-host"><canvas id="' + id + '" data-chart="bar" data-labels="' + labels + '" data-values="' + values + '"></canvas></div>' +
        '<div class="chart-foot">Podemos observar os anúncios que melhor performaram.</div></div></div></section>');
  }

  function buildCriativos(top5, idPrefix, label, scope) {
    let rows = '';
    top5.forEach((ad, i) => {
      const del = scope ? '<button class="cr-del" data-exa="' + esc(ad.name) + '" data-t="' + scope.t + '" data-ci="' + scope.ci + '"' + (scope.si != null ? ' data-si="' + scope.si + '"' : '') + ' title="Remover este anúncio do gráfico e da lista" type="button">×</button>' : '';
      rows += '<div class="cr-row"><image-slot id="' + idPrefix + '-top' + (i + 1) + '" data-ad="' + esc(ad.name) + '" placeholder="thumb"></image-slot>' +
        '<span class="name ed">' + esc(fixBrands(ad.name)) + '</span>' + del + '</div>';
    });
    if (!top5.length) rows = '<div class="cr-row"><span class="name">Sem anúncios neste período.</span></div>';
    return el(
      '<section data-screen-label="Criativos ' + esc(label) + '"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="crit-head"><h2 class="title-chip ed">ANÚNCIOS</h2>' +
        '<div class="cap ed">Abaixo, os criativos que melhor performaram, conforme o gráfico acima.</div></div>' +
        '<div class="cr-frame">' + rows + '</div></div></section>');
  }

  function buildConjunto(m, label, key) {
    key = key || 'set:';
    const cell = (ico, n, l, hk, kind) => '<div class="set-cell" data-hkey="' + esc(hk) + '" data-kind="' + esc(kind) + '">' +
      '<button class="kpi-hide" data-hide="' + esc(hk) + '" title="Ocultar este dado" type="button">×</button>' +
      '<div class="ico"><svg><use href="#' + ico + '"/></svg></div>' +
      '<div><div class="n ed">' + n + '</div><div class="l ed">' + l + '</div></div></div>';
    const strip =
      cell('ico-upload', fmtInt(m.metrics.ads) + ' Ads', 'Ativos', key + 'ads', 'ativos') +
      cell('ico-eye', fmtInt(m.metrics.results), 'Resultados', key + 'res', 'resultados') +
      cell('ico-money', fmtCur(m.metrics.cpr), 'Custo', key + 'custo', 'custo_resultado') +
      cell('ico-money-cycle', fmtCur(m.metrics.spend), 'Investidos', key + 'inv', 'valor');
    return el(
      '<section data-screen-label="' + esc(label) + '"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="title-row"><h2 class="title-chip ed">' + esc(label) + '</h2></div>' +
        '<div class="set-frame"><div class="set-strip">' + strip + '</div></div>' +
        '<div class="set-foot">Aqui, podemos observar o desempenho deste conjunto.</div></div></section>');
  }

  // ── página de detalhamento por Idade / Gênero / Plataforma ────────
  // brk = { age:[], gender:[], platform:[] }. Plataforma vem do 2º Excel.
  function buildBreakdown(brk, label, idPrefix) {
    const B = DISCOVERED.breakdowns || {};
    const dims = [];
    if (B.age && brk.age && brk.age.length) dims.push(['age', 'IDADE', brk.age, false]);
    if (B.gender && brk.gender && brk.gender.length) dims.push(['gender', 'GÊNERO', brk.gender, false]);
    if (B.platform && brk.platform && brk.platform.length) dims.push(['platform', 'PLATAFORMA', brk.platform, true]);
    if (!dims.length) return null;
    const cell = (dim, title, data, fromSec) => {
      const metric = (CONFIG.brkMetric && CONFIG.brkMetric[dim]) || 'spend';
      const isCur = metric !== 'results';
      const labels = esc(JSON.stringify(data.map((o) => trDim(o.key))));
      const values = esc(JSON.stringify(data.map((o) => metric === 'results' ? Math.round(o.results) : +(+o.spend).toFixed(2))));
      const id = idPrefix + '-' + dim;
      const heading = (metric === 'results' ? 'RESULTADO POR ' : 'INVESTIDO POR ') + title;
      // Idade → colunas em pé (ordem natural por faixa); Gênero/Plataforma → rosca com %
      const ctype = dim === 'age' ? 'col' : 'donut';
      return '<div class="brk-cell"><div class="brk-head"><span class="brk-title ed">' + heading + '</span></div>' +
        '<div class="brk-host"><canvas id="' + id + '" data-chart="' + ctype + '" data-fmt="' + (isCur ? 'cur' : 'int') + '" data-labels="' + labels + '" data-values="' + values + '"></canvas></div>' +
        (ctype === 'donut' ? '<div class="brk-legend" data-legend-for="' + id + '"></div>' : '') +
        (fromSec ? '<div class="brk-src">fonte: 2º relatório (plataforma)</div>' : '') + '</div>';
    };
    const cells = dims.map((d) => cell(d[0], d[1], d[2], d[3])).join('');
    return el(
      '<section data-screen-label="Detalhamento ' + esc(label) + '"><div class="bracket-frame"><i class="tl"></i><i class="tr"></i><i class="bl"></i><i class="br"></i></div>' +
        '<div class="slide-pad"><div class="title-row"><h2 class="title-chip ed">DETALHAMENTO — ' + esc(label) + '</h2></div>' +
        '<div class="brk-grid cols-' + dims.length + '">' + cells + '</div></div></section>');
  }

  // Plataforma vem do 2º Excel (PLATFORM_DATA), casada por nome.
  function platformForCampaign(name) {
    if (!PLATFORM_DATA) return [];
    const c = PLATFORM_DATA.campaigns.find((x) => x.name === name);
    return c ? c.breakdown.platform : [];
  }
  function platformForAdsets(names) {
    if (!PLATFORM_DATA) return [];
    const m = new Map();
    PLATFORM_DATA.campaigns.forEach((c) => c.adsets.forEach((a) => {
      if (names.indexOf(a.name) >= 0) (a.breakdown.platform || []).forEach((o) => {
        const g = m.get(o.key) || { spend: 0, results: 0 }; g.spend += o.spend; g.results += o.results; m.set(o.key, g);
      });
    }));
    return [...m.entries()].map(([key, v]) => ({ key, spend: v.spend, results: v.results })).sort((x, y) => y.spend - x.spend);
  }

  // Top 5 efetivo de cada seção: usa a seleção manual (top5Override) ou o
  // ranking completo, removendo anúncios excluídos (exclAds) e promovendo o
  // próximo. Mostra só os que existem (até 5), sem caixas vazias.
  function topForCampaign(cc) {
    const ex = cc.exclAds || [];
    const base = cc.top5Override || cc.ref.adsAll || cc.ref.top5 || [];
    return base.filter((a) => ex.indexOf(a.name) < 0).slice(0, 5);
  }
  function topForConj(cj) {
    const ex = cj.exclAds || [];
    const base = cj.top5Override || candidatesForConj(cj);
    return base.filter((a) => ex.indexOf(a.name) < 0).slice(0, 5);
  }

  // remover um anúncio (× na lista de criativos, em modo edição)
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.cr-del');
    if (!b || !CONFIG) return;
    e.preventDefault(); e.stopPropagation();
    const name = b.dataset.exa;
    const node = b.dataset.t === 'c' ? CONFIG.campaigns[+b.dataset.ci] : CONFIG.campaigns[+b.dataset.ci].conjuntos[+b.dataset.si];
    if (node) { node.exclAds = node.exclAds || []; if (node.exclAds.indexOf(name) < 0) node.exclAds.push(name); render(); }
  }, true);

  // ── render ─────────────────────────────────────────────────────────
  function render() {
    const deck = document.getElementById('deck');
    // destrói os gráficos antigos ANTES de limpar o deck (senão o Chart.js
    // segura as instâncias na memória a cada re-render → vazamento)
    deck.querySelectorAll('canvas').forEach((c) => { if (c.__chart) { c.__chart.destroy(); c.__chart = null; } });
    deck.innerHTML = '';
    const secs = [];
    const push = (sec, group) => { if (sec) { sec.dataset.group = group; secs.push(sec); } };
    push(buildCover(), 'Geral'); push(buildObjetivos(), 'Geral'); push(buildVisaoGeral(), 'Geral');
    CONFIG.campaigns.forEach((cc, ci) => {
      if (!cc.include) return;
      const g = 'Campanha · ' + cc.label;
      push(buildCampanha(cc), g);
      const tC = topForCampaign(cc);
      if (cc.showChart) {
        push(buildChart(tC, 'chart-c' + ci, cc.label), g);
        // detalhamento da campanha logo após o gráfico (padroniza com conjuntos)
        push(buildBreakdown({ age: cc.ref.breakdown.age, gender: cc.ref.breakdown.gender, platform: platformForCampaign(cc.ref.name) }, cc.label, 'brk-c' + ci), g);
        push(buildCriativos(tC, 'cmp' + ci, cc.label, { t: 'c', ci: ci }), g);
      } else {
        push(buildBreakdown({ age: cc.ref.breakdown.age, gender: cc.ref.breakdown.gender, platform: platformForCampaign(cc.ref.name) }, cc.label, 'brk-c' + ci), g);
      }
      cc.conjuntos.forEach((cj, si) => {
        if (!cj.include) return;
        const disp = dispConj(cc, cj); // "TAG-CAMPANHA | NOME DO CONJUNTO"
        const cg = 'Conjunto · ' + disp;
        const m = mergeAdsets(cj.refs);
        const tS = topForConj(cj);
        push(buildConjunto(m, disp, 'set:' + cj.refs.map((r) => r.name).join('|') + ':'), cg);
        push(buildChart(tS, 'chart-c' + ci + 's' + si, disp), cg);
        push(buildBreakdown({ age: m.breakdown.age, gender: m.breakdown.gender, platform: platformForAdsets(cj.refs.map((r) => r.name)) }, disp, 'brk-c' + ci + 's' + si), cg);
        push(buildCriativos(tS, 'cmp' + ci + 's' + si, disp, { t: 's', ci: ci, si: si }), cg);
      });
    });
    secs.forEach((s) => deck.appendChild(s));
    // remove dados ocultados (por instância: data-hkey; tipo global: data-kind)
    const hid = CONFIG.hidden || [], hk = CONFIG.hiddenKinds || [];
    if (hid.length || hk.length) {
      [...deck.querySelectorAll('[data-hkey],[data-kind]')].forEach((e) => {
        if (hid.indexOf(e.getAttribute('data-hkey')) >= 0 || hk.indexOf(e.getAttribute('data-kind')) >= 0) e.remove();
      });
    }
    buildNav();
    saveConfigSoon(); // cache curto das edições (2h), por relatório
    setTimeout(() => {
      if (window.__renderCharts) window.__renderCharts();
      if (window.__fitNumbers) window.__fitNumbers();
      setEditing(editing);
      hideDeckOverlay(); updatePager();
    }, 60);
  }

  // ── navegador de páginas (drawer) com miniaturas reais ────────────
  let navMaterialized = false;
  function buildNav() {
    const drawer = document.getElementById('nav-drawer');
    if (!drawer) return;
    const slides = [...document.querySelectorAll('#deck > section')];
    let html = '', lastGroup = null;
    slides.forEach((s, i) => {
      const group = s.dataset.group || '';
      if (group !== lastGroup) { html += '<div class="nav-sep">' + esc(group) + '</div>'; lastGroup = group; }
      const lbl = (s.getAttribute('data-screen-label') || ('Slide ' + (i + 1))).replace(/^\d+\s*/, '');
      html += '<div class="nav-item" data-i="' + i + '" title="' + esc(lbl) + '"><span class="nav-num">' + (i + 1) + '</span><div class="nav-frame loading"></div></div>';
    });
    drawer.innerHTML = html;
    navMaterialized = false;
    // se o drawer já está aberto, materializa agora
    if (drawer.classList.contains('open')) materializeThumbs();
  }

  // Constrói a miniatura visual de cada slide: clona o slide, troca os
  // <canvas> por imagem (toDataURL) e os <image-slot> por sua imagem atual,
  // remove ids e escala para caber na moldura 16:9.
  function materializeThumbs() {
    if (navMaterialized) return;
    navMaterialized = true;
    const drawer = document.getElementById('nav-drawer');
    const slides = [...document.querySelectorAll('#deck > section')];
    drawer.querySelectorAll('.nav-item').forEach((item) => {
      const i = +item.dataset.i;
      const s = slides[i];
      const frame = item.querySelector('.nav-frame');
      if (!s || !frame) return;
      try {
        const clone = s.cloneNode(true);
        clone.removeAttribute('id'); clone.removeAttribute('data-screen-label');
        clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
        // a miniatura é só para navegar: tira os controles de exclusão (× de KPI/
        // criativo/anúncio) para ninguém apagar dados clicando sem querer nela.
        clone.querySelectorAll('.kpi-hide, .cr-del, .ad-del').forEach((e) => e.remove());
        clone.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
        clone.style.cssText = 'position:absolute;top:0;left:0;width:1920px;height:1080px;overflow:hidden;background:var(--bg);';
        // gráficos → imagem
        const oc = s.querySelectorAll('canvas'), cc = clone.querySelectorAll('canvas');
        oc.forEach((o, k) => { let url = ''; try { url = o.toDataURL(); } catch (e) {} const img = document.createElement('img'); img.src = url; img.style.cssText = 'width:100%;height:100%;object-fit:contain'; if (cc[k]) cc[k].replaceWith(img); });
        // criativos (image-slot) → imagem atual do slot
        const os = s.querySelectorAll('image-slot'), csl = clone.querySelectorAll('image-slot');
        os.forEach((o, k) => { const im = o.shadowRoot && o.shadowRoot.querySelector('img'); const src = im ? im.src : ''; const d = document.createElement('div'); d.style.cssText = 'width:100%;height:100%;background:#111 ' + (src ? 'center/cover no-repeat' : '') + ';' + (src ? 'background-image:url(' + src + ')' : ''); if (csl[k]) csl[k].replaceWith(d); });
        const scale = document.createElement('div');
        scale.className = 'nav-scale';
        scale.appendChild(clone);
        frame.classList.remove('loading');
        frame.innerHTML = ''; frame.appendChild(scale);
        const sc = frame.clientWidth / 1920;
        scale.style.transform = 'scale(' + sc + ')';
      } catch (e) { frame.classList.remove('loading'); }
    });
  }

  // ocultar um dado individual (× no canto do KPI, em modo edição)
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.kpi-hide');
    if (!b || !CONFIG) return;
    e.preventDefault(); e.stopPropagation();
    const k = b.dataset.hide;
    if (CONFIG.hidden.indexOf(k) < 0) { CONFIG.hidden.push(k); render(); }
  }, true);

  // ── restaurar tudo que foi removido/ocultado ──────────────────────
  // Limpa: KPIs ocultos (×), tipos de KPI ocultos, anúncios excluídos (× nos
  // criativos), top-5 manual e campanhas/conjuntos desmarcados em Configurações.
  function resetExclusions() {
    if (!CONFIG) return;
    let n = 0;
    (CONFIG.campaigns || []).forEach((cc) => {
      if (cc.include === false) { cc.include = true; n++; }
      if (cc.exclAds && cc.exclAds.length) { n += cc.exclAds.length; delete cc.exclAds; }
      if (cc.top5Override) { delete cc.top5Override; n++; }
      (cc.conjuntos || []).forEach((cj) => {
        if (cj.include === false) { cj.include = true; n++; }
        if (cj.exclAds && cj.exclAds.length) { n += cj.exclAds.length; delete cj.exclAds; }
        if (cj.top5Override) { delete cj.top5Override; n++; }
      });
    });
    if (CONFIG.hidden && CONFIG.hidden.length) { n += CONFIG.hidden.length; CONFIG.hidden = []; }
    if (CONFIG.hiddenKinds && CONFIG.hiddenKinds.length) { n += CONFIG.hiddenKinds.length; CONFIG.hiddenKinds = []; }
    render();
    const st = document.getElementById('rt-status');
    if (st) st.textContent = n ? ('Restaurado: ' + n + ' item(ns) que estavam removidos/ocultos voltaram.') : 'Nada para restaurar — nenhum campo estava removido.';
  }

  // navegar ao clicar numa página
  document.addEventListener('click', (e) => {
    const it = e.target.closest && e.target.closest('#nav-drawer .nav-item');
    if (!it) return;
    const deck = document.getElementById('deck');
    const i = +it.dataset.i;
    if (deck && deck._go) deck._go(i, 'thumb');
  });

  // destaca a página atual conforme o deck navega
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d.slideIndexChanged === 'number') {
      CUR = d.slideIndexChanged;
      updatePager();
      document.querySelectorAll('#nav-drawer .nav-item').forEach((x) => x.classList.toggle('current', +x.dataset.i === d.slideIndexChanged));
    }
  });

  // ── Zoom + navegação de páginas (barra única #deck-bar) ───────────
  let ZOOM = 1, CUR = 0;
  function applyZoom() {
    const deck = document.getElementById('deck'); if (!deck) return;
    if (ZOOM <= 1.001) { deck.style.zoom = ''; deck.style.position = ''; deck.style.width = ''; deck.style.height = ''; }
    else { deck.style.position = 'relative'; deck.style.width = '100vw'; deck.style.height = '100vh'; deck.style.zoom = String(ZOOM); }
    const lbl = document.getElementById('zoom-lbl'); if (lbl) lbl.textContent = ZOOM <= 1.001 ? 'Ajustar' : Math.round(ZOOM * 100) + '%';
  }
  function setZoom(z) { ZOOM = Math.max(1, Math.min(3, Math.round(z * 100) / 100)); applyZoom(); }
  window.addEventListener('beforeprint', () => { if (ZOOM !== 1) setZoom(1); }); // imprime sempre em 100%
  function updatePager() {
    const total = document.querySelectorAll('#deck > section').length;
    const lbl = document.getElementById('pg-lbl'); if (lbl) lbl.textContent = total ? (CUR + 1) + ' / ' + total : '– / –';
  }
  function deckGo(i) { const deck = document.getElementById('deck'); const total = document.querySelectorAll('#deck > section').length; if (deck && deck._go) deck._go(Math.max(0, Math.min(total - 1, i))); }
  // esconde a barrinha preta nativa do deck-stage (substituída pela #deck-bar)
  function hideDeckOverlay() {
    const deck = document.getElementById('deck');
    if (deck && deck.shadowRoot && !deck.shadowRoot.getElementById('db-hide-ov')) {
      const st = document.createElement('style'); st.id = 'db-hide-ov'; st.textContent = '.overlay{display:none!important}';
      deck.shadowRoot.appendChild(st);
    }
  }

  // ── edição inline ──────────────────────────────────────────────────
  function setEditing(on) {
    editing = on;
    document.querySelectorAll('#deck .ed').forEach((e) => { e.contentEditable = on ? 'true' : 'false'; e.spellcheck = false; });
    document.body.classList.toggle('rt-editing', on);
    const btn = document.getElementById('rt-edit'); if (btn) btn.textContent = 'Editar: ' + (on ? 'ON' : 'OFF');
  }
  document.addEventListener('blur', (e) => { if (e.target && e.target.classList && e.target.classList.contains('ed') && window.__fitNumbers) window.__fitNumbers(); }, true);
  document.body.classList.add('rt-editing'); // .ed usa o mesmo realce de [data-field]

  // ── toolbar ─────────────────────────────────────────────────────────
  // ── Campos obrigatórios para validar o upload (V1) ──────────────────
  // A V1 exibe TODOS estes KPIs (Visão Geral): Alcance, Impressões, Cliques,
  // CPC, CTR, Frequência, Resultados, Custo, Valor — além de Detalhamento por
  // Idade/Gênero. Como CPC=Valor/Cliques, CTR=Cliques/Impressões e
  // Frequência=Impressões/Alcance são CALCULADOS, exigir Cliques/Impressões/
  // Alcance já cobre os três. Idade/Gênero agora OBRIGATÓRIOS na V1 também.
  // (Seguidores é manual — digitado em Configurações, não vem de coluna.)
  // "Tipo de resultado" só recomendado (dá o rótulo do objetivo).
  const REQ_MAIN = ['campaign', 'adset', 'ad', 'results', 'spend', 'impressions', 'reach', 'clicks', 'age', 'gender', 'start'];
  const WARN_MAIN = ['result_type', 'followers'];
  // Relatório 2: valida Plataforma E Posicionamento + os campos que o app cruza
  // com o principal (valor/impressões/resultados/período/campanha) p/ flagrar discrepância.
  const REQ_PLAT = ['campaign', 'platform', 'placement', 'spend', 'impressions', 'results', 'start'];

  async function onFile(file, status) {
    if (typeof XLSX === 'undefined') { status.textContent = 'XLSX não carregou.'; return; }
    status.textContent = 'Lendo ' + file.name + '…';
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
      const headers = aoa[0] || [], rows = aoa.slice(1);
      window.__parser.clearSessionOverrides(); // ajustes de coluna valem só para este envio
      const ssErr = (txt) => { const ok = document.getElementById('ss-ok-msg'); if (ok) { ok.textContent = txt; ok.classList.add('ss-err'); } };
      const proceed = async () => {
        try {
          try { window.__parser.fromWorkbook(wb); } catch (e) {} // popula o cache p/ "Mapear colunas"
          DISCOVERED = window.__parser.discover(headers, rows);
          // namespace das imagens/config por relatório (impressão digital do Excel)
          window.__slotNS = (file.name || 'rep') + '|' + (file.size || 0) + '|' + (file.lastModified || 0);
          CONFIG = (await maybeRestoreConfig(DISCOVERED)) || buildConfig(DISCOVERED);
          render();
          if (window.__slotsReload) window.__slotsReload(window.__slotNS);
          const nC = CONFIG.campaigns.length, nS = CONFIG.campaigns.reduce((a, c) => a + c.conjuntos.length, 0);
          status.textContent = DISCOVERED.period.month + '/' + DISCOVERED.period.year + ' · ' + nC + ' campanha(s), ' + nS + ' conjunto(s).';
          const ss = document.getElementById('start-screen');
          if (ss && !ss.classList.contains('hidden')) {
            const ok = document.getElementById('ss-ok-msg');
            if (ok) {
              ok.classList.remove('ss-err');
              const warnMiss = window.__parser.validate(headers, WARN_MAIN).missing.map((k) => window.__parser.colLabel(k));
              ok.textContent = '✓ Relatório 1 carregado: ' + DISCOVERED.period.month + '/' + DISCOVERED.period.year + ' · ' + nC + ' campanha(s), ' + nS + ' conjunto(s).' + (warnMiss.length ? ' (sem ' + warnMiss.join(', ') + ')' : '');
            }
            wizReport1OK();
          }
        } catch (err) { status.textContent = 'Erro: ' + err.message; }
      };
      const miss = window.__parser.validate(headers, REQ_MAIN).missing;
      if (miss.length) {
        const names = miss.map((k) => window.__parser.colLabel(k)).join(', ');
        status.textContent = '❌ Relatório inválido — faltam: ' + names;
        ssErr('❌ Relatório 1 inválido — faltam: ' + names + '. Aponte as colunas no painel.');
        window.__parser.openValidator({ headers, blockKeys: REQ_MAIN, warnKeys: WARN_MAIN, title: 'Relatório 1 (principal)', onResolved: proceed });
        return;
      }
      await proceed();
    } catch (err) { status.textContent = 'Erro: ' + err.message; }
  }

  // ── 2º Excel (plataforma) — opcional, só para os gráficos de plataforma ──
  function validatePlatform(P) {
    const w = [], D = DISCOVERED;
    const pct = (a, b) => (b ? Math.abs(a - b) / b : (a ? 1 : 0));
    if (P.period.month !== D.period.month || P.period.year !== D.period.year)
      w.push('Período diferente: principal ' + D.period.month + '/' + D.period.year + ' × plataforma ' + P.period.month + '/' + P.period.year);
    if (pct(P.overall.spend, D.overall.spend) > 0.05)
      w.push('Investimento total difere ' + (pct(P.overall.spend, D.overall.spend) * 100).toFixed(0) + '% (R$ ' + D.overall.spend.toFixed(0) + ' × R$ ' + P.overall.spend.toFixed(0) + ')');
    if (pct(P.overall.impressions, D.overall.impressions) > 0.05)
      w.push('Impressões diferem ' + (pct(P.overall.impressions, D.overall.impressions) * 100).toFixed(0) + '%');
    if (pct(P.overall.results, D.overall.results) > 0.05)
      w.push('Resultados diferem ' + (pct(P.overall.results, D.overall.results) * 100).toFixed(0) + '%');
    const dNames = new Set(D.campaigns.map((c) => c.name));
    const overlap = P.campaigns.filter((c) => dNames.has(c.name)).length;
    if (overlap === 0) w.push('Nenhuma campanha em comum (nomes não batem)');
    else if (overlap < P.campaigns.length) w.push((P.campaigns.length - overlap) + ' campanha(s) do 2º arquivo não existem no principal');
    return w;
  }
  async function onPlatformFile(file, status) {
    const setMsg = (t, err) => { if (status) status.textContent = t; const pm = document.getElementById('ss-plat-msg'); if (pm) { pm.textContent = t; pm.classList.toggle('ss-err', !!err); } };
    if (!DISCOVERED) { setMsg('Suba o Relatório 1 (principal) primeiro.', true); return; }
    setMsg('Lendo Relatório 2 (plataforma): ' + file.name + '…');
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: true });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
      const headers = aoa[0] || [], rows = aoa.slice(1);
      window.__parser.clearSessionOverrides();
      const proceed = () => {
        const P = window.__parser.discover(headers, rows);
        if (!P.breakdowns.platform) { setMsg('⚠ Este arquivo não tem a coluna Plataforma com dados — nada a fazer.', true); return; }
        const warns = validatePlatform(P);
        if (warns.length) {
          const ok = window.confirm('Atenção — o Relatório 2 (plataforma) tem diferenças em relação ao principal:\n\n• ' + warns.join('\n• ') + '\n\nUsar mesmo assim, só para os gráficos de plataforma?');
          if (!ok) { setMsg('Relatório 2 cancelado.', true); return; }
        }
        PLATFORM_DATA = P;
        DISCOVERED.breakdowns.platform = true;
        render();
        setMsg('✓ Relatório 2 (plataforma) carregado de ' + file.name + (warns.length ? ' (com avisos).' : '.'));
        wizReport2OK();
      };
      const miss = window.__parser.validate(headers, REQ_PLAT).missing;
      if (miss.length) {
        const names = miss.map((k) => window.__parser.colLabel(k)).join(', ');
        setMsg('❌ Relatório 2 inválido — faltam: ' + names + '. Aponte as colunas no painel.', true);
        window.__parser.openValidator({ headers, blockKeys: REQ_PLAT, warnKeys: [], title: 'Relatório 2 (plataforma)', onResolved: proceed });
        return;
      }
      proceed();
    } catch (err) { setMsg('Erro ao ler Relatório 2: ' + err.message, true); }
  }

  // ── Assistente de upload (3 passos) — navegação e liberação dos botões ──
  let __wizR1 = false, __wizR2 = false;
  function wizCurrent() { const a = document.querySelector('#start-screen .ss-page.is-active'); return a ? +a.dataset.page : 0; }
  function wizStep(n) {
    const ss = document.getElementById('start-screen'); if (!ss) return;
    const pages = ss.querySelectorAll('.ss-page'); const max = pages.length - 1;
    n = Math.max(0, Math.min(max, n));
    pages.forEach((p) => p.classList.toggle('is-active', +p.dataset.page === n));
    ss.querySelectorAll('.ss-step-dot').forEach((d) => { const i = +d.dataset.go; d.classList.toggle('is-active', i === n); d.classList.toggle('is-done', i < n); });
  }
  function wizReport1OK() { __wizR1 = true; const b = document.getElementById('ss-next-1'); if (b) b.disabled = false; }
  function wizReport2OK() { __wizR2 = true; const g = document.getElementById('ss-go'); if (g) g.disabled = false; }

  // ── modo "Dados de exemplo": carrega o par de Excel correto (principal +
  //    plataforma) de exel/exemplo/ (par validado que bate entre si). ──
  async function loadTestData(status) {
    const base = 'exel/exemplo/';
    const mainName = 'principal.xlsx';
    const platName = 'plataforma.xlsx';
    const grab = async (name) => {
      const r = await fetch(base + encodeURIComponent(name));
      if (!r.ok) throw new Error(name + ' (HTTP ' + r.status + ')');
      const b = await r.arrayBuffer();
      return new File([b], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', lastModified: 1700000000000 });
    };
    try {
      if (status) status.textContent = 'Carregando dados de exemplo…';
      await onFile(await grab(mainName), status);
      await onPlatformFile(await grab(platName), status);
      const ss = document.getElementById('start-screen'); if (ss) ss.classList.add('hidden');
      if (status) status.textContent = 'Dados de exemplo carregados (principal + plataforma).';
    } catch (e) { if (status) status.textContent = 'Erro nos dados de teste: ' + e.message; }
  }

  // Após remapear colunas no painel "Mapear colunas", re-descobre e re-renderiza.
  window.__afterRemap = () => {
    const c = window.__parser.getCache && window.__parser.getCache();
    if (!c) return;
    const snap = CONFIG ? serializeConfig(CONFIG) : null; // preserva as edições atuais
    DISCOVERED = window.__parser.discover(c.headers, c.rows);
    CONFIG = snap ? applyConfigSnapshot(snap, DISCOVERED) : buildConfig(DISCOVERED);
    render();
    const st = document.getElementById('rt-status');
    if (st) st.textContent = 'Colunas remapeadas e reprocessado.';
  };

  function wire() {
    const $ = (id) => document.getElementById(id);
    const status = $('rt-status');
    const vEl = $('rt-version'); if (vEl) vEl.textContent = 'Versão ' + APP_VERSION + ' · V1';
    if ($('rt-file')) $('rt-file').addEventListener('change', (e) => { if (e.target.files[0]) onFile(e.target.files[0], status); });
    if ($('rt-testdata')) $('rt-testdata').addEventListener('click', () => loadTestData(status));
    if ($('rt-edit')) $('rt-edit').addEventListener('click', () => setEditing(!editing));
    if ($('rt-pdf')) $('rt-pdf').addEventListener('click', () => {
      const empty = [...document.querySelectorAll('#deck image-slot')].filter((s) => !s.hasAttribute('data-filled')).length;
      if (empty && !window.confirm(empty + ' criativo(s) ainda sem imagem. Exportar o PDF mesmo assim?')) return;
      window.print();
    });
    if ($('rt-config')) $('rt-config').addEventListener('click', () => window.__parser && window.__parser.openConfig());
    if ($('rt-sections')) $('rt-sections').addEventListener('click', openSections);
    if ($('rt-restore')) $('rt-restore').addEventListener('click', resetExclusions);
    if ($('rt-images')) $('rt-images').addEventListener('change', (e) => { if (e.target.files.length) matchImages(e.target.files, status); e.target.value = ''; });
    if ($('rt-platform')) $('rt-platform').addEventListener('change', (e) => { if (e.target.files[0]) onPlatformFile(e.target.files[0], status); e.target.value = ''; });
    if ($('rt-fab')) $('rt-fab').addEventListener('click', () => document.getElementById('report-toolbar').classList.toggle('open'));
    const goHome = () => { location.href = 'index.html'; };
    if ($('rt-home')) $('rt-home').addEventListener('click', goHome);
    if ($('ss-home')) $('ss-home').addEventListener('click', goHome);
    if ($('zoom-in')) $('zoom-in').addEventListener('click', () => setZoom(ZOOM + 0.25));
    if ($('zoom-out')) $('zoom-out').addEventListener('click', () => setZoom(ZOOM - 0.25));
    if ($('zoom-reset')) $('zoom-reset').addEventListener('click', () => setZoom(1));
    if ($('pg-prev')) $('pg-prev').addEventListener('click', () => deckGo(CUR - 1));
    if ($('pg-next')) $('pg-next').addEventListener('click', () => deckGo(CUR + 1));
    hideDeckOverlay(); updatePager();
    const toggleDrawer = () => {
      const dr = document.getElementById('nav-drawer');
      dr.classList.toggle('open');
      if (dr.classList.contains('open')) setTimeout(materializeThumbs, 30);
    };
    if ($('rt-pages')) $('rt-pages').addEventListener('click', toggleDrawer);
    if ($('nav-toggle')) $('nav-toggle').addEventListener('click', toggleDrawer);

    // Tela inicial (a escolha de versão fica no index.html)
    if ($('ss-pick')) $('ss-pick').addEventListener('click', () => $('rt-file').click());
    if ($('ss-testdata')) $('ss-testdata').addEventListener('click', () => loadTestData(status));
    if ($('ss-pick-plat')) $('ss-pick-plat').addEventListener('click', () => $('rt-platform').click());
    if ($('ss-go')) $('ss-go').addEventListener('click', () => { if (!__wizR2) return; const ss = document.getElementById('start-screen'); if (ss) ss.classList.add('hidden'); });
    // assistente de upload: navegação entre os 3 passos
    document.querySelectorAll('#start-screen [data-next]').forEach((b) => b.addEventListener('click', () => wizStep(wizCurrent() + 1)));
    document.querySelectorAll('#start-screen [data-prev]').forEach((b) => b.addEventListener('click', () => wizStep(wizCurrent() - 1)));
    document.querySelectorAll('#start-screen .ss-step-dot').forEach((d) => d.addEventListener('click', () => { const i = +d.dataset.go; if (i === 2 && !__wizR1) return; wizStep(i); }));
  }

  // ── painel de Seções (ocultar / mesclar / reordenar / rótulos) ────
  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; };

  function openSections() {
    if (!CONFIG) { const s = document.getElementById('rt-status'); if (s) s.textContent = 'Suba um relatório primeiro.'; return; }
    let host = document.getElementById('cfg-backdrop');
    if (host) host.remove();
    host = document.createElement('div'); host.id = 'cfg-backdrop'; host.className = 'export-hidden';
    host.innerHTML = '<div class="cfg-card" id="sec-card"></div>';
    document.body.appendChild(host);
    host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
    const card = host.querySelector('#sec-card');

    function paint() {
      let h = '<h3>Configurações</h3>' +
        '<div class="sec-row" style="border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:10px;margin-bottom:6px">' +
        '<b>Alcance real (conta):</b>' +
        '<input class="sec-lbl" style="flex:0 0 130px" data-act="rall" value="' + (CONFIG.reachOverall != null ? CONFIG.reachOverall : '') + '" placeholder="auto (estimado)">' +
        '<small style="color:var(--ink-soft)">único, do painel da Meta — corrige Alcance e Frequência</small></div>';
      // Seguidores (manual): não vem no export de anúncios; vira um KPI na Visão Geral se preenchido.
      h += '<div class="sec-row" style="border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:10px;margin-bottom:6px"><b>Seguidores (período):</b>' +
        '<input class="sec-lbl" style="flex:0 0 130px" data-act="followers" value="' + (CONFIG.followers != null ? CONFIG.followers : '') + '" placeholder="ex: 320">' +
        '<small style="color:var(--ink-soft)">manual — aparece como KPI na Visão Geral</small></div>';
      // Nome dos conjuntos: resumido (padrão) x inteiro
      h += '<div class="sec-row" style="border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:10px;margin-bottom:6px"><b>Nomes dos conjuntos:</b>' +
        '<button class="sec-mini' + (!CONFIG.fullConjNames ? ' on' : '') + '" data-act="cjname" data-mode="short">Resumido</button>' +
        '<button class="sec-mini' + (CONFIG.fullConjNames ? ' on' : '') + '" data-act="cjname" data-mode="full">Nome inteiro</button>' +
        '<small style="color:var(--ink-soft)">inteiro usa o nome completo do conjunto (a fonte diminui p/ caber)</small></div>';
      // Detalhamento (métrica global por dimensão)
      const B = DISCOVERED.breakdowns || {};
      const dimList = [['age', 'Idade'], ['gender', 'Gênero'], ['platform', 'Plataforma']].filter((d) => B[d[0]]);
      if (dimList.length) {
        h += '<div class="sec-block"><b>Detalhamento (Idade/Gênero/Plataforma)</b>' + dimList.map((d) => {
          const cur = (CONFIG.brkMetric && CONFIG.brkMetric[d[0]]) || 'spend';
          return '<div class="sec-row"><span style="min-width:84px">' + d[1] + ':</span>' +
            '<button class="sec-mini' + (cur !== 'results' ? ' on' : '') + '" data-act="brkm" data-dim="' + d[0] + '" data-m="spend">Investido</button>' +
            '<button class="sec-mini' + (cur === 'results' ? ' on' : '') + '" data-act="brkm" data-dim="' + d[0] + '" data-m="results">Resultado</button></div>';
        }).join('') + '</div>';
      }
      // Ocultar tipos de KPI em todo o relatório
      const KINDS = [['alcance', 'Alcance'], ['impressoes', 'Impressões'], ['cliques', 'Cliques'], ['cpc', 'CPC'], ['ctr', 'CTR'], ['frequencia', 'Frequência'], ['resultados', 'Resultados'], ['custo_resultado', 'Custo por resultado'], ['valor', 'Valor/Investido'], ['ativos', 'Ads ativos'], ['seguidores', 'Seguidores']];
      h += '<div class="sec-block"><b>Ocultar dados em todo o relatório</b><div class="kind-grid">' + KINDS.map((k) => {
        const on = (CONFIG.hiddenKinds || []).indexOf(k[0]) >= 0;
        return '<label><input type="checkbox" data-act="kind" data-kind="' + k[0] + '"' + (on ? ' checked' : '') + '> ' + k[1] + '</label>';
      }).join('') + '</div></div>';
      h += '<div class="sec-block"><b>Seções</b><p style="margin:4px 0 8px;font-size:12px;color:var(--ink-soft)">Reordene (▲▼), renomeie, oculte e marque conjuntos (☑) para mesclar.</p>' +
        ((CONFIG.hidden && CONFIG.hidden.length) ? '<div class="sec-row">Dados individuais ocultos: ' + CONFIG.hidden.length + ' <button class="sec-mini" data-act="unhide">restaurar</button></div>' : '') + '</div>';
      CONFIG.campaigns.forEach((cc, ci) => {
        h += '<div class="sec-camp"><div class="sec-row">' +
          '<button class="sec-mini" data-act="cup" data-ci="' + ci + '">▲</button>' +
          '<button class="sec-mini" data-act="cdn" data-ci="' + ci + '">▼</button>' +
          '<input class="sec-lbl" data-act="clbl" data-ci="' + ci + '" value="' + esc(cc.label) + '">' +
          '<label><input type="checkbox" data-act="cinc" data-ci="' + ci + '" ' + (cc.include ? 'checked' : '') + '> incluir</label>' +
          '<label><input type="checkbox" data-act="cchart" data-ci="' + ci + '" ' + (cc.showChart ? 'checked' : '') + '> gráfico</label>' +
          '<button class="sec-mini" data-act="t5c" data-ci="' + ci + '">Top 5' + (cc.top5Override ? ' ✎' : '') + '</button>' +
          '<input class="sec-lbl" style="flex:0 0 120px" data-act="rcamp" data-ci="' + ci + '" value="' + (cc.reachReal != null ? cc.reachReal : '') + '" placeholder="alcance real">' +
          '</div>';
        cc.conjuntos.forEach((cj, si) => {
          h += '<div class="sec-row sec-conj">' +
            '<input type="checkbox" class="msel" data-ci="' + ci + '" data-si="' + si + '" title="marcar para mesclar">' +
            '<button class="sec-mini" data-act="jup" data-ci="' + ci + '" data-si="' + si + '">▲</button>' +
            '<button class="sec-mini" data-act="jdn" data-ci="' + ci + '" data-si="' + si + '">▼</button>' +
            '<input class="sec-lbl" data-act="jlbl" data-ci="' + ci + '" data-si="' + si + '" value="' + esc(cj.label) + '">' +
            '<label><input type="checkbox" data-act="jinc" data-ci="' + ci + '" data-si="' + si + '" ' + (cj.include ? 'checked' : '') + '> incluir</label>' +
            '<button class="sec-mini" data-act="t5j" data-ci="' + ci + '" data-si="' + si + '">Top 5' + (cj.top5Override ? ' ✎' : '') + '</button>' +
            (cj.refs.length > 1 ? '<button class="sec-mini" data-act="jsplit" data-ci="' + ci + '" data-si="' + si + '">desmesclar</button>' : '') +
            '</div>';
        });
        h += '<button class="rt-btn sec-merge" data-act="merge" data-ci="' + ci + '">Mesclar marcados</button></div>';
      });
      h += '<div class="sec-block" style="border-top:1px solid rgba(255,255,255,.12);margin-top:8px;padding-top:10px">' +
        '<b>Perfil de configuração</b>' +
        '<p style="margin:4px 0 8px;font-size:12px;color:var(--ink-soft)">Salve seus ajustes num arquivo para reusar no próximo mês (importa e só os números mudam). Casa por nome de campanha/conjunto.</p>' +
        '<div class="sec-row"><button class="sec-mini" data-act="cfgexport">⬇ Exportar config</button>' +
        '<button class="sec-mini" data-act="cfgimport">⬆ Importar config</button></div></div>';
      h += '<div class="cfg-actions"><button id="sec-close" class="rt-btn" style="background:#444;color:#fff">Fechar</button></div>';
      card.innerHTML = h;
      card.querySelector('#sec-close').onclick = () => host.remove();
    }

    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act, ci = +b.dataset.ci, si = +b.dataset.si;
      const cjs = CONFIG.campaigns[ci] && CONFIG.campaigns[ci].conjuntos;
      if (act === 'cup') move(CONFIG.campaigns, ci, -1);
      else if (act === 'cdn') move(CONFIG.campaigns, ci, 1);
      else if (act === 'jup') move(cjs, si, -1);
      else if (act === 'jdn') move(cjs, si, 1);
      else if (act === 'jsplit') {
        const cj = cjs[si];
        const extra = cj.refs.slice(1).map((r) => ({ refs: [r], label: conjLabel([r]), labelAuto: true, include: true }));
        cj.refs = [cj.refs[0]]; cj.label = conjLabel([cj.refs[0]]); cj.labelAuto = true;
        cjs.splice(si + 1, 0, ...extra);
      } else if (act === 'cjname') {
        CONFIG.fullConjNames = (b.dataset.mode === 'full');
        CONFIG.campaigns.forEach((c) => c.conjuntos.forEach((cj) => { if (cj.labelAuto !== false) cj.label = conjLabel(cj.refs); }));
        render(); paint(); return;
      } else if (act === 'merge') {
        const idxs = [...card.querySelectorAll('.msel:checked')].filter((x) => +x.dataset.ci === ci).map((x) => +x.dataset.si).sort((a, b) => a - b);
        if (idxs.length < 2) { return; }
        const refs = [].concat(...idxs.map((k) => cjs[k].refs));
        const label = 'CONJUNTO ' + idxs.map((k) => cjs[k].label.replace(/^CONJUNTO\s*/i, '')).join(' + ');
        for (let k = idxs.length - 1; k >= 1; k--) cjs.splice(idxs[k], 1);
        cjs[idxs[0]] = { refs, label, include: true };
      } else if (act === 'unhide') {
        CONFIG.hidden = []; render(); paint(); return;
      } else if (act === 'brkm') {
        CONFIG.brkMetric = CONFIG.brkMetric || {}; CONFIG.brkMetric[b.dataset.dim] = b.dataset.m; render(); paint(); return;
      } else if (act === 't5c') {
        const cc = CONFIG.campaigns[ci];
        openTop5(cc, candidatesForCampaign(cc), cc.ref.top5, cc.label, () => paint());
        return;
      } else if (act === 't5j') {
        const cj = cjs[si];
        openTop5(cj, candidatesForConj(cj), mergeAdsets(cj.refs).top5, cj.label, () => paint());
        return;
      } else if (act === 'cfgexport') { exportConfig(); return; }
      else if (act === 'cfgimport') { importConfigPrompt(); return; }
      else return;
      render(); paint();
    });
    card.addEventListener('change', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act, ci = +b.dataset.ci, si = +b.dataset.si;
      if (act === 'cinc') CONFIG.campaigns[ci].include = b.checked;
      else if (act === 'cchart') CONFIG.campaigns[ci].showChart = b.checked;
      else if (act === 'jinc') CONFIG.campaigns[ci].conjuntos[si].include = b.checked;
      else if (act === 'kind') { const k = b.dataset.kind, arr = CONFIG.hiddenKinds, idx = arr.indexOf(k); if (b.checked && idx < 0) arr.push(k); else if (!b.checked && idx >= 0) arr.splice(idx, 1); }
      else return;
      render();
    });
    card.addEventListener('input', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'clbl') CONFIG.campaigns[+b.dataset.ci].label = b.value;
      else if (b.dataset.act === 'jlbl') { const cj = CONFIG.campaigns[+b.dataset.ci].conjuntos[+b.dataset.si]; cj.label = b.value; cj.labelAuto = false; }
      else if (b.dataset.act === 'rall') { const v = parseInt(String(b.value).replace(/\D/g, ''), 10); CONFIG.reachOverall = isNaN(v) ? null : v; }
      else if (b.dataset.act === 'rcamp') { const v = parseInt(String(b.value).replace(/\D/g, ''), 10); CONFIG.campaigns[+b.dataset.ci].reachReal = isNaN(v) ? null : v; }
      else if (b.dataset.act === 'followers') { const v = parseInt(String(b.value).replace(/\D/g, ''), 10); CONFIG.followers = isNaN(v) ? null : v; }
    });
    card.addEventListener('blur', (e) => {
      const b = e.target.closest && e.target.closest('[data-act]');
      if (b && ['clbl', 'jlbl', 'rall', 'rcamp', 'followers'].indexOf(b.dataset.act) >= 0) render();
    }, true);

    paint();
  }

  // ── editor de Top 5 (escolher quais anúncios e a ordem) ───────────
  function candidatesForCampaign(cc) { return (cc.ref.adsAll && cc.ref.adsAll.length) ? cc.ref.adsAll : cc.ref.top5; }
  function candidatesForConj(cj) {
    const m = new Map();
    cj.refs.forEach((a) => (a.adsList || []).forEach(([n, r, sp]) => { const g = m.get(n) || { res: 0, spend: 0 }; g.res += r; g.spend += (sp || 0); m.set(n, g); }));
    const arr = [...m.entries()].sort(cmpAdEntry).map(([n, v]) => ({ name: n, results: Math.round(v.res) }));
    return arr.length ? arr : mergeAdsets(cj.refs).top5;
  }

  function openTop5(node, candidates, defaultTop5, label, after) {
    const selNames = (node.top5Override || defaultTop5 || []).map((x) => x.name);
    const byName = new Map(candidates.map((c) => [c.name, c.results]));
    let work = [];
    selNames.forEach((n) => { if (byName.has(n)) work.push({ name: n, results: byName.get(n), sel: true }); });
    candidates.forEach((c) => { if (selNames.indexOf(c.name) < 0) work.push({ name: c.name, results: c.results, sel: false }); });

    let host = document.getElementById('t5-backdrop'); if (host) host.remove();
    host = document.createElement('div'); host.id = 't5-backdrop'; host.className = 'export-hidden';
    host.innerHTML = '<div class="t5-card" id="t5-card"></div>';
    document.body.appendChild(host);
    host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
    const card = host.querySelector('#t5-card');

    function paintT() {
      let h = '<h3>Top 5 — ' + esc(label) + '</h3><p>Marque até 5 anúncios e ordene com ▲▼. Os 5 primeiros marcados entram no gráfico e na lista.</p>';
      work.forEach((w, i) => {
        h += '<div class="sec-row"><input type="checkbox" data-i="' + i + '" ' + (w.sel ? 'checked' : '') + '>' +
          '<button class="sec-mini" data-up="' + i + '">▲</button><button class="sec-mini" data-dn="' + i + '">▼</button>' +
          '<span class="t5-name">' + esc(w.name) + '</span><span class="t5-res">' + w.results + '</span></div>';
      });
      h += '<div class="cfg-actions"><button id="t5-apply" class="rt-btn">Aplicar</button>' +
        '<button id="t5-auto" class="rt-btn" style="background:#444;color:#fff">Automático</button>' +
        '<button id="t5-close" class="rt-btn" style="background:#444;color:#fff">Fechar</button></div>';
      card.innerHTML = h;
      card.querySelector('#t5-close').onclick = () => host.remove();
      card.querySelector('#t5-auto').onclick = () => { delete node.top5Override; delete node.exclAds; host.remove(); render(); if (after) after(); };
      card.querySelector('#t5-apply').onclick = () => {
        const chosen = work.filter((w) => w.sel).slice(0, 5).map((w) => ({ name: w.name, results: w.results }));
        if (chosen.length) node.top5Override = chosen; else delete node.top5Override;
        host.remove(); render(); if (after) after();
      };
    }
    card.addEventListener('click', (e) => {
      const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-dn]');
      if (up) { const i = +up.dataset.up; if (i > 0) { const t = work[i]; work[i] = work[i - 1]; work[i - 1] = t; } paintT(); }
      else if (dn) { const i = +dn.dataset.dn; if (i < work.length - 1) { const t = work[i]; work[i] = work[i + 1]; work[i + 1] = t; } paintT(); }
    });
    card.addEventListener('change', (e) => { const cb = e.target.closest('input[data-i]'); if (cb) work[+cb.dataset.i].sel = cb.checked; });
    paintT();
  }

  // ── casamento de imagens por nome de arquivo ──────────────────────
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]/g, '');
  function matchImages(files, status) {
    const slots = [...document.querySelectorAll('#deck image-slot[data-ad]')].filter((s) => s.getAttribute('data-ad'));
    const list = [...files].map((f) => ({ f, key: normName(f.name) }));
    let matched = 0;
    slots.forEach((slot) => {
      const adKey = normName(slot.getAttribute('data-ad'));
      if (!adKey) return;
      let best = null, score = 0;
      list.forEach((fl) => {
        let s = 0;
        if (fl.key && fl.key === adKey) s = 9999;
        else if (fl.key && (adKey.indexOf(fl.key) >= 0 || fl.key.indexOf(adKey) >= 0)) s = Math.min(fl.key.length, adKey.length);
        if (s > score) { score = s; best = fl; }
      });
      if (best && score > 0 && window.__feedSlot && window.__feedSlot(slot, best.f)) matched++;
    });
    if (status) status.textContent = 'Imagens casadas: ' + matched + ' de ' + slots.length + ' slots.';
  }

  window.__render = { render, buildConfig, get config() { return CONFIG; }, get discovered() { return DISCOVERED; } };
  window.addEventListener('load', wire);
})();
