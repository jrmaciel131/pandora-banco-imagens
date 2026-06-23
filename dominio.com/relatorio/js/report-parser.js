/* ─────────────────────────────────────────────────────────────────
   report-parser.js — lê o export bruto do Meta Ads e gera os dados do
   relatório. Tudo CONFIGURÁVEL: as colunas são achadas pelo título
   (ignorando acento/caixa). Se o Meta mudar a posição/nome, abra
   "Mapear colunas" e defina a coluna manualmente (letra: A, B, …).
   Os overrides ficam salvos no navegador (localStorage).
   ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── CONFIG ────────────────────────────────────────────────────────
  // Cada coluna lógica e os títulos que o Meta costuma usar.
  const COLUMNS = {
    campaign:    { label: 'Nome da campanha',        aliases: ['nome da campanha', 'campaign name'] },
    adset:       { label: 'Conjunto de anúncios',    aliases: ['nome do conjunto de anuncios', 'ad set name'] },
    ad:          { label: 'Nome do anúncio',         aliases: ['nome do anuncio', 'ad name'] },
    results:     { label: 'Resultados',              aliases: ['resultados', 'results'] },
    result_type: { label: 'Tipo de resultado',       aliases: ['tipo de resultado', 'result type'] },
    spend:       { label: 'Valor usado (BRL)',       aliases: ['valor usado (brl)', 'valor usado', 'amount spent (brl)', 'amount spent'] },
    impressions: { label: 'Impressões',              aliases: ['impressoes', 'impressions'] },
    reach:       { label: 'Alcance',                 aliases: ['alcance', 'reach'] },
    clicks:      { label: 'Cliques no link',         aliases: ['cliques no link', 'link clicks'] },
    start:       { label: 'Início dos relatórios',   aliases: ['inicio dos relatorios', 'reporting starts'] },
    age:         { label: 'Idade',                   aliases: ['idade', 'age'] },
    gender:      { label: 'Gênero',                  aliases: ['genero', 'gender', 'sexo'] },
    platform:    { label: 'Plataforma',              aliases: ['plataforma', 'plataforma de veiculacao', 'platform'] },
    placement:   { label: 'Posicionamento',          aliases: ['posicionamento', 'posicionamento de veiculacao', 'placement'] },
    followers:   { label: 'Seguidores no Instagram', aliases: ['seguidores no instagram', 'seguidores', 'instagram followers', 'follows'] },
    views:       { label: 'Visualizações de vídeo',  aliases: ['visualizacoes de video', 'visualizacoes', 'reproducoes de video', 'reproducoes de video de 3 segundos', 'reproducoes de video de ate 3 segundos', 'video plays', '3-second video plays', 'thruplays', 'reproducoes'] },
  };

  // Regras de segmento (por trecho do nome). Editáveis aqui.
  const SEGMENTS = {
    eng: { campaignIncludes: '[ENG-WA]' },                       // Engajamento WhatsApp
    vis: { campaignIncludes: '[TF-IG]' },                        // Visitas ao perfil IG
    c31: { campaignIncludes: '[TF-IG]', adsetStartsWith: '3.1' },// Conjunto 3.1
    c32: { campaignIncludes: '[TF-IG]', adsetStartsWith: '3.2' },// Conjunto 3.2
  };

  // Tipo de formatação por campo do relatório.
  const FMT = {
    alcance: 'k', impressoes: 'k', cliques: 'k', cpc: 'cur', ctr: 'pct', frequencia: 'dec',
    conversas: 'int', custo_conversa: 'cur', visitas: 'int', custo_visita: 'cur',
    seguidores: 'na', valor_usado: 'cur',
    eng_resultados: 'int', eng_alcance: 'k', eng_impressoes: 'k', eng_cpr: 'cur', eng_valor: 'cur',
    vis_resultados: 'int', vis_alcance: 'k', vis_impressoes: 'k', vis_cpr: 'cur', vis_valor: 'cur',
    c31_ativos: 'int', c31_resultados: 'int', c31_custo: 'cur', c31_invest: 'cur',
    c32_ativos: 'int', c32_resultados: 'int', c32_custo: 'cur', c32_invest: 'cur',
  };

  const MESES = ['JANEIRO', 'FEVEREIRO', 'MARÇO', 'ABRIL', 'MAIO', 'JUNHO',
    'JULHO', 'AGOSTO', 'SETEMBRO', 'OUTUBRO', 'NOVEMBRO', 'DEZEMBRO'];
  const LS_KEY = 'relatorio_col_overrides';
  // Overrides apontados na VALIDAÇÃO do upload — valem só nesta sessão/envio
  // (NÃO persistem). Têm precedência sobre o auto e sobre os overrides salvos.
  let SESSION_OVERRIDES = {}; // key -> índice de coluna

  // ── util ──────────────────────────────────────────────────────────
  const norm = (s) => String(s == null ? '' : s).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const colLetter = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const letterToIndex = (L) => { L = String(L).toUpperCase().replace(/[^A-Z]/g, ''); if (!L) return -1; let n = 0; for (const c of L) n = n * 26 + (c.charCodeAt(0) - 64); return n - 1; };

  const fmtInt = (n) => Math.round(n).toLocaleString('pt-BR');
  const fmtK = (n) => { if (Math.abs(n) >= 1000) { return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K'; } return fmtInt(n); };
  const fmtCur = (n) => isFinite(n) ? 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'NA';
  const fmtPct = (r) => isFinite(r) ? (r * 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%' : 'NA';
  const fmtDec = (n) => isFinite(n) ? n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'NA';
  const div = (a, b) => (b ? a / b : NaN);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  let CACHE = null; // { headers, rows }

  // ── localStorage overrides ────────────────────────────────────────
  function loadOverrides() { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } }
  function saveOverrides(o) { try { localStorage.setItem(LS_KEY, JSON.stringify(o)); } catch (e) {} }

  // ── resolução de colunas (auto pelo título + override manual) ──────
  function resolveColumns(headers) {
    const normed = headers.map(norm);
    const overrides = loadOverrides();
    const map = {};
    Object.keys(COLUMNS).forEach((key) => {
      let idx = -1, source = 'auto';
      // 1) override de sessão (apontado na validação do upload — não persiste)
      if (SESSION_OVERRIDES[key] != null && SESSION_OVERRIDES[key] >= 0) { idx = SESSION_OVERRIDES[key]; source = 'session'; }
      // 2) override manual salvo (letra de coluna, localStorage)
      if (idx < 0 && overrides[key]) { idx = letterToIndex(overrides[key]); source = 'manual'; }
      // 3) auto pelo título
      if (idx < 0) {
        for (const alias of COLUMNS[key].aliases) {
          const a = norm(alias);
          const found = normed.findIndex((h) => h === a || h.includes(a));
          if (found >= 0) { idx = found; break; }
        }
      }
      map[key] = { idx, source, header: idx >= 0 ? headers[idx] : null, letter: idx >= 0 ? colLetter(idx) : null };
    });
    return map;
  }

  // ── agregação ──────────────────────────────────────────────────────
  function emptyAgg() { return { res: 0, spend: 0, impr: 0, reach: 0, clicks: 0, followers: 0, ads: new Map() }; }
  function addRow(a, vals) {
    a.res += vals.results; a.spend += vals.spend; a.impr += vals.impressions;
    a.reach += vals.reach; a.clicks += vals.clicks; a.followers += (vals.followers || 0);
    if (vals.ad) { const e = a.ads.get(vals.ad) || { res: 0, spend: 0 }; e.res += vals.results; e.spend += vals.spend; a.ads.set(vals.ad, e); }
  }
  // Ranking de anúncios: mais RESULTADOS primeiro; em EMPATE, MENOR valor gasto
  // primeiro (mais eficiente); persistindo o empate, ordem alfabética (determinístico).
  // Cada entrada de agg.ads é [nome, { res, spend }].
  function cmpAdEntries(x, y) { return (y[1].res - x[1].res) || (x[1].spend - y[1].spend) || String(x[0]).localeCompare(String(y[0])); }
  function adEntriesSorted(map) { return [...map.entries()].sort(cmpAdEntries); }
  function top5(agg) { return adEntriesSorted(agg.ads).slice(0, 5); }

  function build(headers, rows) {
    const c = resolveColumns(headers);
    const missing = Object.keys(COLUMNS).filter((k) => c[k].idx < 0 && !['start', 'age', 'gender', 'platform', 'placement', 'followers', 'result_type', 'views'].includes(k));
    const get = (row, key) => (c[key].idx >= 0 ? row[c[key].idx] : '');

    const overall = emptyAgg(), eng = emptyAgg(), vis = emptyAgg(), c31 = emptyAgg(), c32 = emptyAgg();
    const monthCount = {}; // "ano-mes" -> contagem (pega o mês predominante)

    rows.forEach((row) => {
      const camp = String(get(row, 'campaign') || '');
      const adset = String(get(row, 'adset') || '');
      const vals = {
        ad: String(get(row, 'ad') || '').trim(),
        results: num(get(row, 'results')), spend: num(get(row, 'spend')),
        impressions: num(get(row, 'impressions')), reach: num(get(row, 'reach')),
        clicks: num(get(row, 'clicks')),
      };
      addRow(overall, vals);
      if (SEGMENTS.eng.campaignIncludes && camp.includes(SEGMENTS.eng.campaignIncludes)) addRow(eng, vals);
      if (SEGMENTS.vis.campaignIncludes && camp.includes(SEGMENTS.vis.campaignIncludes)) {
        addRow(vis, vals);
        if (adset.startsWith(SEGMENTS.c31.adsetStartsWith)) addRow(c31, vals);
        else if (adset.startsWith(SEGMENTS.c32.adsetStartsWith)) addRow(c32, vals);
      }
      const d = get(row, 'start');
      let y = null, m = null;
      if (d instanceof Date) { y = d.getUTCFullYear(); m = d.getUTCMonth(); }
      else if (d) { const mt = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); if (mt) { y = +mt[1]; m = +mt[2] - 1; } }
      if (y != null) { const k = y + '-' + m; monthCount[k] = (monthCount[k] || 0) + 1; }
    });

    // mês/ano predominante (evita fuso e linhas fora do período)
    let bestKey = null, bestCount = -1;
    for (const k in monthCount) { if (monthCount[k] > bestCount) { bestCount = monthCount[k]; bestKey = k; } }
    const period = bestKey ? bestKey.split('-').map(Number) : null;

    const fields = {
      month: period ? MESES[period[1]] : 'NA',
      year: period ? String(period[0]) : 'NA',
      // visão geral
      alcance: fmtK(overall.reach), impressoes: fmtK(overall.impr), cliques: fmtK(overall.clicks),
      cpc: fmtCur(div(overall.spend, overall.clicks)), ctr: fmtPct(div(overall.clicks, overall.impr)),
      frequencia: fmtDec(div(overall.impr, overall.reach)),
      conversas: fmtInt(eng.res), custo_conversa: fmtCur(div(eng.spend, eng.res)),
      visitas: fmtInt(vis.res), custo_visita: fmtCur(div(vis.spend, vis.res)),
      seguidores: 'NA', valor_usado: fmtCur(overall.spend),
      // engajamento
      eng_resultados: fmtInt(eng.res), eng_alcance: fmtK(eng.reach), eng_impressoes: fmtK(eng.impr),
      eng_cpr: fmtCur(div(eng.spend, eng.res)), eng_valor: fmtCur(eng.spend),
      // visitas
      vis_resultados: fmtInt(vis.res), vis_alcance: fmtK(vis.reach), vis_impressoes: fmtK(vis.impr),
      vis_cpr: fmtCur(div(vis.spend, vis.res)), vis_valor: fmtCur(vis.spend),
      // conjunto 3.1
      c31_ativos: fmtInt(c31.ads.size), c31_resultados: fmtInt(c31.res),
      c31_custo: fmtCur(div(c31.spend, c31.res)), c31_invest: fmtCur(c31.spend),
      // conjunto 3.2
      c32_ativos: fmtInt(c32.ads.size), c32_resultados: fmtInt(c32.res),
      c32_custo: fmtCur(div(c32.spend, c32.res)), c32_invest: fmtCur(c32.spend),
    };

    const tEng = top5(eng), t31 = top5(c31), t32 = top5(c32);
    [['eng', tEng], ['c31', t31], ['c32', t32]].forEach(([p, t]) => {
      for (let i = 0; i < 5; i++) fields[p + '_top' + (i + 1)] = t[i] ? t[i][0] : 'NA';
    });

    const charts = {
      'chart-eng': { labels: tEng.map((x) => x[0]), values: tEng.map((x) => Math.round(x[1].res)) },
      'chart-c31': { labels: t31.map((x) => x[0]), values: t31.map((x) => Math.round(x[1].res)) },
      'chart-c32': { labels: t32.map((x) => x[0]), values: t32.map((x) => Math.round(x[1].res)) },
    };

    return { fields, charts, _diag: { columns: c, missing, totals: { spend: overall.spend, impr: overall.impr, clicks: overall.clicks } } };
  }

  // ── AUTO-DESCOBERTA (multi campanha/conjunto) ─────────────────────
  // Agrupa o Excel por campanha e, dentro de cada campanha, por conjunto,
  // sem regras fixas. Base para a geração dinâmica de slides (Fase 3).
  function discover(headers, rows) {
    const c = resolveColumns(headers);
    const get = (row, key) => (c[key].idx >= 0 ? row[c[key].idx] : '');
    const monthCount = {};
    const overall = emptyAgg();
    const camps = new Map(); // nome -> {agg, resTypes:Map, adsets:Map, adsetBrk:Map}
    // valores distintos por dimensão (para decidir se a página vale a pena)
    const dimVals = { age: new Set(), gender: new Set(), platform: new Set() };
    const hasCol = { age: c.age.idx >= 0, gender: c.gender.idx >= 0, platform: c.platform.idx >= 0 };
    const isEmptyDim = (v) => !v || /^(unknown|desconhecido|n\/a|na)$/i.test(v);

    rows.forEach((row) => {
      const cn = String(get(row, 'campaign') || '').trim();
      const an = String(get(row, 'adset') || '').trim();
      const vals = {
        ad: String(get(row, 'ad') || '').trim(),
        results: num(get(row, 'results')), spend: num(get(row, 'spend')),
        impressions: num(get(row, 'impressions')), reach: num(get(row, 'reach')),
        clicks: num(get(row, 'clicks')), followers: num(get(row, 'followers')),
      };
      const rt = String(get(row, 'result_type') || '').trim();
      const dim = {
        age: hasCol.age ? String(get(row, 'age') || '').trim() : '',
        gender: hasCol.gender ? String(get(row, 'gender') || '').trim() : '',
        platform: hasCol.platform ? String(get(row, 'platform') || '').trim() : '',
      };
      ['age', 'gender', 'platform'].forEach((d) => { if (dim[d] && !isEmptyDim(dim[d])) dimVals[d].add(dim[d]); });
      addRow(overall, vals);

      if (!camps.has(cn)) camps.set(cn, { agg: emptyAgg(), resTypes: new Map(), adsets: new Map(), adsetBrk: new Map(), brk: { age: new Map(), gender: new Map(), platform: new Map() } });
      const C = camps.get(cn);
      addRow(C.agg, vals);
      if (rt) C.resTypes.set(rt, (C.resTypes.get(rt) || 0) + vals.results);
      const accum = (map, key) => { if (!key) return; const g = map.get(key) || { spend: 0, results: 0 }; g.spend += vals.spend; g.results += vals.results; map.set(key, g); };
      accum(C.brk.age, dim.age); accum(C.brk.gender, dim.gender); accum(C.brk.platform, dim.platform);
      if (an) {
        if (!C.adsets.has(an)) { C.adsets.set(an, emptyAgg()); C.adsetBrk.set(an, { age: new Map(), gender: new Map(), platform: new Map() }); }
        addRow(C.adsets.get(an), vals);
        const b2 = C.adsetBrk.get(an);
        accum(b2.age, dim.age); accum(b2.gender, dim.gender); accum(b2.platform, dim.platform);
      }

      const d = get(row, 'start');
      let y = null, m = null;
      if (d instanceof Date) { y = d.getUTCFullYear(); m = d.getUTCMonth(); }
      else if (d) { const mt = String(d).match(/(\d{4})-(\d{2})-(\d{2})/); if (mt) { y = +mt[1]; m = +mt[2] - 1; } }
      if (y != null) { const k = y + '-' + m; monthCount[k] = (monthCount[k] || 0) + 1; }
    });

    let bestKey = null, bestCount = -1;
    for (const k in monthCount) if (monthCount[k] > bestCount) { bestCount = monthCount[k]; bestKey = k; }
    const period = bestKey ? bestKey.split('-').map(Number) : null;

    const metricsOf = (a) => ({
      results: a.res, spend: a.spend, impressions: a.impr, reach: a.reach, clicks: a.clicks, followers: a.followers,
      ads: a.ads.size, cpr: div(a.spend, a.res), cpc: div(a.spend, a.clicks),
      ctr: div(a.clicks, a.impr), freq: div(a.impr, a.reach),
    });
    const dominant = (mapCounter) => {
      let best = '', bc = -1;
      mapCounter.forEach((v, k) => { if (v > bc) { bc = v; best = k; } });
      return best;
    };

    const brkArr = (map, byKey) => { const arr = [...map.entries()].map(([key, v]) => ({ key, spend: v.spend, results: v.results })); arr.sort(byKey ? (x, y) => String(x.key).localeCompare(String(y.key)) : (x, y) => y.spend - x.spend); return arr; };
    const brkObj = (b) => ({ age: brkArr(b.age, true), gender: brkArr(b.gender, false), platform: brkArr(b.platform, false) });

    const campaigns = [...camps.entries()]
      .sort((x, y) => y[1].agg.spend - x[1].agg.spend)
      .map(([name, C]) => ({
        name,
        resultType: dominant(C.resTypes),
        metrics: metricsOf(C.agg),
        top5: top5(C.agg).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
        // lista completa de anúncios da campanha (para escolher o Top 5)
        adsAll: [...C.agg.ads.entries()].sort(cmpAdEntries).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
        breakdown: brkObj(C.brk),
        adsets: [...C.adsets.entries()]
          .sort((x, y) => y[1].spend - x[1].spend)
          .map(([an, a]) => {
            const brk = C.adsetBrk.get(an) || { age: new Map(), gender: new Map(), platform: new Map() };
            return {
              name: an,
              metrics: metricsOf(a),
              top5: top5(a).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
              // sums brutos + lista de anúncios → permitem mesclar conjuntos depois
              raw: { results: a.res, spend: a.spend, impressions: a.impr, reach: a.reach, clicks: a.clicks },
              adsList: [...a.ads.entries()].map(([n, v]) => [n, v.res, v.spend]),
              breakdown: { age: brkArr(brk.age, true), gender: brkArr(brk.gender, false), platform: brkArr(brk.platform, false) },
            };
          }),
      }));

    return {
      period: period ? { month: MESES[period[1]], year: String(period[0]) } : { month: 'NA', year: 'NA' },
      overall: metricsOf(overall),
      campaigns,
      breakdowns: {
        age: hasCol.age && dimVals.age.size >= 1,
        gender: hasCol.gender && dimVals.gender.size >= 1,
        platform: hasCol.platform && dimVals.platform.size >= 1,
      },
      _columns: c,
    };
  }

  // ── leitura do arquivo ─────────────────────────────────────────────
  function fromWorkbook(wb) {
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, raw: true });
    const headers = aoa[0] || [];
    const rows = aoa.slice(1);
    CACHE = { headers, rows };
    return build(headers, rows);
  }

  async function fromFile(file, status) {
    if (typeof XLSX === 'undefined') { if (status) status.textContent = 'XLSX não carregou.'; return null; }
    if (status) status.textContent = 'Lendo ' + file.name + '…';
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const data = fromWorkbook(wb);
    if (status) {
      const miss = data._diag.missing;
      status.textContent = miss.length
        ? '⚠ Colunas não encontradas: ' + miss.join(', ') + ' — use "Mapear colunas".'
        : 'Relatório carregado: ' + data.fields.month + '/' + data.fields.year + '.';
    }
    return data;
  }

  function reparse() { return CACHE ? build(CACHE.headers, CACHE.rows) : null; }

  // ── painel de configuração de colunas ──────────────────────────────
  function openConfig() {
    const headers = CACHE ? CACHE.headers : [];
    const c = resolveColumns(headers);
    const overrides = loadOverrides();
    let host = document.getElementById('cfg-backdrop');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'cfg-backdrop';
    host.className = 'export-hidden';
    const rows = Object.keys(COLUMNS).map((key) => {
      const r = c[key];
      const status = r.idx >= 0
        ? '<span style="color:#7CFFB2">' + r.letter + ' · ' + (r.header || '') + '</span>'
        : '<span style="color:#ff7a7a">não encontrada</span>';
      return '<tr><td>' + COLUMNS[key].label + '</td><td>' + status +
        (r.source === 'manual' ? ' <em style="color:#5ce1e6">(manual)</em>' : '') +
        '</td><td><input data-key="' + key + '" placeholder="ex: J" value="' + (overrides[key] || '') + '" style="width:64px"></td></tr>';
    }).join('');
    host.innerHTML =
      '<div class="cfg-card">' +
        '<h3>Mapear colunas do Excel</h3>' +
        '<p>O app acha as colunas pelo título. Se mudar, defina a letra da coluna manualmente. <b>Idade/Gênero</b> alimentam o Detalhamento; <b>Plataforma</b> vem do 2º Excel (relatório de plataforma) e o mesmo mapeamento de letra vale para ele.</p>' +
        '<table><thead><tr><th>Campo</th><th>Coluna detectada</th><th>Forçar (letra)</th></tr></thead><tbody>' + rows + '</tbody></table>' +
        (CACHE ? '' : '<p style="color:#ffb86b">Suba um relatório primeiro para ver as colunas detectadas.</p>') +
        '<div class="cfg-actions"><button id="cfg-save" class="rt-btn">Salvar e reprocessar</button>' +
        '<button id="cfg-clear" class="rt-btn" style="background:#444;color:#fff">Limpar overrides</button>' +
        '<button id="cfg-close" class="rt-btn" style="background:#444;color:#fff">Fechar</button></div>' +
      '</div>';
    document.body.appendChild(host);
    host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
    document.getElementById('cfg-close').onclick = () => host.remove();
    document.getElementById('cfg-clear').onclick = () => { saveOverrides({}); host.remove(); (window.__afterRemap || applyReparse)(); };
    document.getElementById('cfg-save').onclick = () => {
      const o = {};
      host.querySelectorAll('input[data-key]').forEach((inp) => { if (inp.value.trim()) o[inp.dataset.key] = inp.value.trim(); });
      saveOverrides(o); host.remove(); (window.__afterRemap || applyReparse)();
    };
  }

  function applyReparse() {
    const data = reparse();
    if (data && window.__report) window.__report.applyData(data);
    const status = document.getElementById('rt-status');
    if (status && data) status.textContent = data._diag.missing.length
      ? '⚠ Ainda faltam colunas: ' + data._diag.missing.join(', ')
      : 'Reprocessado: ' + data.fields.month + '/' + data.fields.year + '.';
  }

  // ── AUTO-DESCOBERTA V2 (rico: série diária, idade×gênero, plataforma c/ alcance, por anúncio) ──
  // Não substitui discover(): a V1 dinâmica continua usando discover().
  // A V2 (layout Canva A4) precisa de mais dimensões por nível
  // (campanha → conjunto → anúncio): linha diária, barra gênero×idade e
  // barra de plataforma (alcance + resultados, vinda do 2º Excel).
  const G_NORM = (g) => {
    const s = norm(g);
    if (!s) return '';
    if (/fem|mulh|women|^f$/.test(s)) return 'female';
    if (/masc|homem|^men$|^male$|^m$|^h$/.test(s)) return 'male';
    return 'unknown';
  };
  const dateKey = (d) => {
    if (d instanceof Date) {
      return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    const mt = String(d == null ? '' : d).match(/(\d{4})-(\d{2})-(\d{2})/);
    return mt ? mt[1] + '-' + mt[2] + '-' + mt[3] : null;
  };
  const ageCmp = (a, b) => {
    const na = parseInt(a, 10), nb = parseInt(b, 10);
    return (isNaN(na) ? Infinity : na) - (isNaN(nb) ? Infinity : nb);
  };
  // Epoch (UTC, ms) de uma data 'YYYY-MM-DD' e o caminho inverso.
  const WK_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const epToKey = (ep) => { const d = new Date(ep); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); };
  // Rótulo do período pelas datas REAIS da semana (min–max): '12–18 mai',
  // '29 abr–4 mai' (cruza o mês) ou '12 mai' (um dia só).
  const spanLabel = (minS, maxS) => {
    const a = minS.split('-').map(Number), b = maxS.split('-').map(Number);
    if (minS === maxS) return a[2] + ' ' + WK_ABBR[a[1] - 1];
    if (a[1] === b[1]) return a[2] + '–' + b[2] + ' ' + WK_ABBR[b[1] - 1];
    return a[2] + ' ' + WK_ABBR[a[1] - 1] + '–' + b[2] + ' ' + WK_ABBR[b[1] - 1];
  };
  // Categoria do "Tipo de resultado" → indicador da evolução. Mensagem casa
  // 'mensag' ou a palavra 'conversa(s)'; conversão casa conversao/cadastro/lead/
  // compra/registro (NÃO confundir 'conversao' com 'conversa').
  const resultCat = (rt) => {
    const s = norm(rt);
    if (!s) return null;
    if (/mensag/.test(s) || /\bconversas?\b/.test(s)) return 'msg';
    if (/perfil|profile/.test(s)) return 'visits';
    if (/conversao|conversoes|cadastr|\blead/.test(s) || /compra|purchase|registr|assinatura/.test(s)) return 'conv';
    return null;
  };

  function discoverV2(headers, rows) {
    const c = resolveColumns(headers);
    const get = (row, key) => (c[key].idx >= 0 ? row[c[key].idx] : '');
    const hasCol = { age: c.age.idx >= 0, gender: c.gender.idx >= 0, platform: c.platform.idx >= 0 };
    const isEmptyDim = (v) => !v || /^(unknown|desconhecido|n\/a|na)$/i.test(v);
    const dimVals = { age: new Set(), gender: new Set(), platform: new Set() };
    const monthCount = {};
    // Evolução (página de comparativo): acumula por DIA; as semanas são montadas
    // depois, ancoradas no ÚLTIMO dia do relatório (evita semana parcial no fim).
    const evoDays = new Map();

    // detalhe acumulado (reutilizado em campanha / conjunto / anúncio)
    const mkD = () => ({ res: 0, spend: 0, impr: 0, reach: 0, clicks: 0, ads: new Map(), daily: new Map(), ag: new Map(), plat: new Map() });
    function addD(D, vals, dk, ageK, genK, platK) {
      D.res += vals.results; D.spend += vals.spend; D.impr += vals.impressions; D.reach += vals.reach; D.clicks += vals.clicks;
      if (vals.ad) { const e = D.ads.get(vals.ad) || { res: 0, spend: 0 }; e.res += vals.results; e.spend += vals.spend; D.ads.set(vals.ad, e); }
      if (dk) { const g = D.daily.get(dk) || { spend: 0, results: 0, impr: 0 }; g.spend += vals.spend; g.results += vals.results; g.impr += vals.impressions; D.daily.set(dk, g); }
      if (ageK !== '' || genK !== '') { const k = ageK + '␟' + genK; const g = D.ag.get(k) || { spend: 0, results: 0, reach: 0 }; g.spend += vals.spend; g.results += vals.results; g.reach += vals.reach; D.ag.set(k, g); }
      if (platK) { const g = D.plat.get(platK) || { spend: 0, results: 0, reach: 0 }; g.spend += vals.spend; g.results += vals.results; g.reach += vals.reach; D.plat.set(platK, g); }
    }

    const overall = mkD();
    const camps = new Map(); // name -> { D, resTypes:Map, adsets:Map(name -> { D, ads:Map(name -> D) }) }

    rows.forEach((row) => {
      const cn = String(get(row, 'campaign') || '').trim();
      const an = String(get(row, 'adset') || '').trim();
      const vals = {
        ad: String(get(row, 'ad') || '').trim(),
        results: num(get(row, 'results')), spend: num(get(row, 'spend')),
        impressions: num(get(row, 'impressions')), reach: num(get(row, 'reach')),
        clicks: num(get(row, 'clicks')),
      };
      const rt = String(get(row, 'result_type') || '').trim();
      const ageRaw = hasCol.age ? String(get(row, 'age') || '').trim() : '';
      const genRaw = hasCol.gender ? String(get(row, 'gender') || '').trim() : '';
      const platRaw = hasCol.platform ? String(get(row, 'platform') || '').trim() : '';
      if (ageRaw && !isEmptyDim(ageRaw)) dimVals.age.add(ageRaw);
      if (genRaw && !isEmptyDim(genRaw)) dimVals.gender.add(genRaw);
      if (platRaw && !isEmptyDim(platRaw)) dimVals.platform.add(platRaw);
      const dk = dateKey(get(row, 'start'));
      const ageK = hasCol.age ? (ageRaw || 'unknown') : '';
      const genK = hasCol.gender ? (G_NORM(genRaw) || 'unknown') : '';
      const platK = platRaw || '';

      addD(overall, vals, dk, ageK, genK, platK);
      if (!camps.has(cn)) camps.set(cn, { D: mkD(), resTypes: new Map(), adsets: new Map() });
      const C = camps.get(cn);
      addD(C.D, vals, dk, ageK, genK, platK);
      if (rt) C.resTypes.set(rt, (C.resTypes.get(rt) || 0) + vals.results);
      if (an) {
        if (!C.adsets.has(an)) C.adsets.set(an, { D: mkD(), ads: new Map() });
        const A = C.adsets.get(an);
        addD(A.D, vals, dk, ageK, genK, platK);
        if (vals.ad) {
          if (!A.ads.has(vals.ad)) A.ads.set(vals.ad, mkD());
          addD(A.ads.get(vals.ad), vals, dk, ageK, genK, platK);
        }
      }
      if (dk) {
        const k = dk.slice(0, 7); monthCount[k] = (monthCount[k] || 0) + 1;
        let D = evoDays.get(dk);
        if (!D) { D = { spend: 0, results: 0, msg: 0, visits: 0, conv: 0, impr: 0, reach: 0, views: 0, fol: 0 }; evoDays.set(dk, D); }
        D.spend += vals.spend; D.results += vals.results; D.impr += vals.impressions; D.reach += vals.reach;
        D.views += num(get(row, 'views'));
        const cat = resultCat(rt);
        if (cat) D[cat] += vals.results;
        const fol = num(get(row, 'followers')); // seguidores é snapshot do dia (maior valor)
        if (fol > D.fol) D.fol = fol;
      }
    });

    let bestKey = null, bestCount = -1;
    for (const k in monthCount) if (monthCount[k] > bestCount) { bestCount = monthCount[k]; bestKey = k; }
    const period = bestKey ? bestKey.split('-').map(Number) : null;

    const metricsOf = (D) => ({
      results: D.res, spend: D.spend, impressions: D.impr, reach: D.reach, clicks: D.clicks,
      ads: D.ads.size, cpr: div(D.spend, D.res), cpc: div(D.spend, D.clicks),
      ctr: div(D.clicks, D.impr), freq: div(D.impr, D.reach),
    });
    const dailyArr = (D) => [...D.daily.entries()]
      .map(([date, v]) => ({ date, spend: v.spend, results: v.results, impr: v.impr }))
      .sort((x, y) => x.date < y.date ? -1 : x.date > y.date ? 1 : 0);
    const platArr = (D) => [...D.plat.entries()]
      .map(([key, v]) => ({ key, spend: v.spend, results: v.results, reach: v.reach }))
      .sort((x, y) => y.spend - x.spend);
    // cruzamento idade×gênero → { ages, series:[{name,gender,values}], totals:{gender:{results,spend}} }
    function ageGender(D) {
      const ages = new Set(), totals = {};
      const byAgeGen = new Map(); // age -> gender -> {results,spend}
      D.ag.forEach((v, k) => {
        const [a, g] = k.split('␟');
        const age = a || 'unknown', gen = g || 'unknown';
        ages.add(age);
        if (!byAgeGen.has(age)) byAgeGen.set(age, {});
        const slot = byAgeGen.get(age);
        slot[gen] = slot[gen] || { results: 0, spend: 0 };
        slot[gen].results += v.results; slot[gen].spend += v.spend;
        totals[gen] = totals[gen] || { results: 0, spend: 0 };
        totals[gen].results += v.results; totals[gen].spend += v.spend;
      });
      const ageList = [...ages].sort(ageCmp);
      const order = [['male', 'Homens'], ['female', 'Mulheres']];
      if ((totals.unknown && totals.unknown.results > 0)) order.push(['unknown', 'Desconhecido']);
      const series = order.map(([gen, name]) => ({
        name, gender: gen,
        values: ageList.map((age) => { const s = byAgeGen.get(age); return s && s[gen] ? Math.round(s[gen].results) : 0; }),
      }));
      return { ages: ageList, series, totals };
    }
    const dominant = (mapCounter) => { let best = '', bc = -1; mapCounter.forEach((v, k) => { if (v > bc) { bc = v; best = k; } }); return best; };
    const detailOut = (D) => ({
      metrics: metricsOf(D),
      daily: dailyArr(D),
      ageGender: ageGender(D),
      platform: platArr(D),
      reach: D.reach,
    });

    const campaigns = [...camps.entries()]
      .sort((x, y) => y[1].D.spend - x[1].D.spend)
      .map(([name, C]) => {
        const adsetsOut = [...C.adsets.entries()]
          .sort((x, y) => y[1].D.spend - x[1].D.spend)
          .map(([an, A]) => Object.assign(detailOut(A.D), {
            name: an,
            top5: top5(A.D).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
            adsAll: [...A.D.ads.entries()].sort(cmpAdEntries).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
            raw: { results: A.D.res, spend: A.D.spend, impressions: A.D.impr, reach: A.D.reach, clicks: A.D.clicks },
            adsList: [...A.D.ads.entries()].map(([n, v]) => [n, v.res, v.spend]),
            ads: [...A.ads.entries()]
              .sort((x, y) => y[1].spend - x[1].spend)
              .map(([adn, D]) => Object.assign(detailOut(D), { name: adn })),
          }));
        return Object.assign(detailOut(C.D), {
          name,
          resultType: dominant(C.resTypes),
          top5: top5(C.D).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
          adsAll: [...C.D.ads.entries()].sort(cmpAdEntries).map(([n, v]) => ({ name: n, results: Math.round(v.res) })),
          adsets: adsetsOut,
        });
      });

    // Monta as semanas a partir dos dias, ANCORADAS no último dia do relatório:
    // blocos de 7 dias terminando no último dia → a semana mais recente é sempre
    // completa (não cai no gráfico por causa de uma semana parcial no fim).
    const DAY_MS = 86400000;
    const dayKeys = [...evoDays.keys()].sort();
    let weekArr = [];
    if (dayKeys.length) {
      const toEp = (s) => { const p = s.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]); };
      const lastEp = toEp(dayKeys[dayKeys.length - 1]);
      const buckets = new Map();
      dayKeys.forEach((dk) => {
        const endEp = lastEp - Math.floor((lastEp - toEp(dk)) / (7 * DAY_MS)) * 7 * DAY_MS;
        const endKey = epToKey(endEp);
        let B = buckets.get(endKey);
        if (!B) { B = { end: endKey, min: dk, max: dk, spend: 0, results: 0, msg: 0, visits: 0, conv: 0, impr: 0, reach: 0, views: 0, folDate: '', fol: 0 }; buckets.set(endKey, B); }
        const D = evoDays.get(dk);
        B.spend += D.spend; B.results += D.results; B.msg += D.msg; B.visits += D.visits; B.conv += D.conv; B.impr += D.impr; B.reach += D.reach; B.views += D.views;
        if (dk < B.min) B.min = dk;
        if (dk > B.max) B.max = dk;
        if (D.fol > 0 && dk >= B.folDate) { B.folDate = dk; B.fol = D.fol; }
      });
      weekArr = [...buckets.values()].sort((a, b) => (a.end < b.end ? -1 : 1)).map((B) => ({
        key: B.end, label: spanLabel(B.min, B.max),
        spend: B.spend, results: B.results, msg: B.msg, visits: B.visits, conv: B.conv,
        impr: B.impr, reach: B.reach, views: B.views, cpr: div(B.spend, B.results), followers: B.fol,
      }));
    }
    const anyPos = (sel) => weekArr.some((w) => sel(w) > 0);
    const hasMsg = c.result_type.idx >= 0 && anyPos((w) => w.msg);
    const hasVisits = c.result_type.idx >= 0 && anyPos((w) => w.visits);
    const hasConv = c.result_type.idx >= 0 && anyPos((w) => w.conv);
    const evolution = {
      weeks: weekArr,
      months: Object.keys(monthCount).length,
      available: {
        msg: hasMsg, visits: hasVisits, conv: hasConv,
        // "Resultados" genérico só quando o tipo não casa msg/visitas/conversão.
        res: anyPos((w) => w.results) && !(hasMsg || hasVisits || hasConv),
        cpr: anyPos((w) => w.results),
        impr: c.impressions.idx >= 0 && anyPos((w) => w.impr),
        reach: c.reach.idx >= 0 && anyPos((w) => w.reach),
        views: c.views.idx >= 0 && anyPos((w) => w.views),
        followers: c.followers.idx >= 0 && anyPos((w) => w.followers),
      },
    };

    // Faixa real de datas (1º → último dia com dado). Usada para comparar dois
    // arquivos do MESMO período (mesmo que o "mês predominante" difira) e para
    // rotular relatórios de vários meses sem reduzir a um mês só.
    const range = dayKeys.length ? { first: dayKeys[0], last: dayKeys[dayKeys.length - 1] } : { first: null, last: null };
    let periodObj;
    if (period && Object.keys(monthCount).length > 1 && range.first) {
      const f = range.first.split('-').map(Number), l = range.last.split('-').map(Number);
      periodObj = (f[0] === l[0])
        ? { month: MESES[f[1] - 1] + ' a ' + MESES[l[1] - 1], year: String(f[0]) }
        : { month: MESES[f[1] - 1] + '/' + f[0] + ' a ' + MESES[l[1] - 1] + '/' + l[0], year: '' };
    } else {
      periodObj = period ? { month: MESES[period[1] - 1], year: String(period[0]) } : { month: 'NA', year: 'NA' };
    }

    return {
      period: periodObj,
      range: range,
      overall: metricsOf(overall),
      campaigns,
      evolution,
      breakdowns: {
        age: hasCol.age && dimVals.age.size >= 1,
        gender: hasCol.gender && dimVals.gender.size >= 1,
        platform: hasCol.platform && dimVals.platform.size >= 1,
      },
      _columns: c,
    };
  }

  // ── VALIDAÇÃO de colunas no upload ─────────────────────────────────
  function inspect(headers) { return resolveColumns(headers || (CACHE ? CACHE.headers : [])); }
  function colLabel(key) { return COLUMNS[key] ? COLUMNS[key].label : key; }
  function getColumnDefs() { return Object.keys(COLUMNS).map((k) => ({ key: k, label: COLUMNS[k].label })); }
  function setSessionOverride(key, idx) { if (idx == null || idx < 0) delete SESSION_OVERRIDES[key]; else SESSION_OVERRIDES[key] = idx; }
  function clearSessionOverrides() { SESSION_OVERRIDES = {}; }
  // Retorna { missing:[keys], columns } para um conjunto de campos obrigatórios.
  function validate(headers, requiredKeys) {
    const c = resolveColumns(headers || []);
    return { missing: (requiredKeys || []).filter((k) => !c[k] || c[k].idx < 0), columns: c };
  }

  // Painel que BLOQUEIA o upload enquanto faltar campo obrigatório. Lista cada
  // campo (✓/✗) e, num dropdown com as colunas REAIS do Excel, deixa apontar a
  // coluna certa (override só desta sessão). Só libera quando tudo resolver.
  function openValidator(opts) {
    opts = opts || {};
    const headers = opts.headers || [];
    const blockKeys = opts.blockKeys || [];
    const warnKeys = opts.warnKeys || [];
    const title = opts.title || '';
    let host = document.getElementById('colval-backdrop'); if (host) host.remove();
    host = document.createElement('div'); host.id = 'colval-backdrop'; host.className = 'export-hidden';
    const optionList = headers.map((h, i) => '<option value="' + i + '">' + colLetter(i) + ' · ' + esc(String(h == null ? '' : h)) + '</option>').join('');
    const mkRow = (key, tier) => '<tr data-row="' + key + '">' +
        '<td>' + esc(colLabel(key)) + (tier === 'warn' ? ' <em class="cv-rec">(recomendado)</em>' : '') + '</td>' +
        '<td class="cv-stat"></td>' +
        '<td><select data-key="' + key + '"><option value="">— escolher coluna —</option>' + optionList + '</select></td></tr>';
    host.innerHTML =
      '<div class="cfg-card">' +
        '<h3>Relatório inválido — faltam colunas</h3>' +
        '<p>' + esc(title) + ': estes campos são necessários e não foram todos encontrados no Excel. Aponte a coluna correta no menu — ou cancele e exporte de novo incluindo os campos. <b>O ajuste vale só para este envio.</b></p>' +
        '<table><thead><tr><th>Campo</th><th>Situação</th><th>Apontar coluna</th></tr></thead><tbody>' +
          blockKeys.map((k) => mkRow(k, 'block')).join('') +
          (warnKeys.length ? '<tr class="cv-sep"><td colspan="3">Recomendados — não bloqueiam</td></tr>' + warnKeys.map((k) => mkRow(k, 'warn')).join('') : '') +
        '</tbody></table>' +
        '<div id="cv-msg" class="cv-msg"></div>' +
        '<div class="cfg-actions"><button id="cv-go" class="rt-btn">Revalidar e continuar</button>' +
        '<button id="cv-cancel" class="rt-btn" style="background:#444;color:#fff">Cancelar</button></div>' +
      '</div>';
    document.body.appendChild(host);
    const refresh = () => {
      const c = resolveColumns(headers); let allOk = true;
      blockKeys.concat(warnKeys).forEach((key) => {
        const tr = host.querySelector('tr[data-row="' + key + '"]'); if (!tr) return;
        const ok = c[key] && c[key].idx >= 0;
        tr.querySelector('.cv-stat').innerHTML = ok
          ? '<span class="cv-ok">✓ ' + c[key].letter + ' · ' + esc(String(c[key].header || '')) + '</span>'
          : '<span class="cv-bad">✗ não encontrada</span>';
        tr.classList.toggle('cv-bad-row', !ok && blockKeys.indexOf(key) >= 0);
        if (blockKeys.indexOf(key) >= 0 && !ok) allOk = false;
      });
      const go = document.getElementById('cv-go'); if (go) go.disabled = !allOk;
      const msg = document.getElementById('cv-msg');
      if (msg) { msg.textContent = allOk ? '✓ Todos os campos obrigatórios encontrados — pode continuar.' : 'Aponte as colunas em vermelho para continuar.'; msg.className = 'cv-msg ' + (allOk ? 'cv-ok' : 'cv-bad'); }
      return allOk;
    };
    // pré-seleciona no dropdown a coluna já resolvida (quando houver)
    const c0 = resolveColumns(headers);
    host.querySelectorAll('select[data-key]').forEach((sel) => {
      const key = sel.dataset.key; if (c0[key] && c0[key].idx >= 0) sel.value = String(c0[key].idx);
      sel.addEventListener('change', () => { setSessionOverride(key, sel.value === '' ? null : parseInt(sel.value, 10)); refresh(); });
    });
    const close = () => host.remove();
    host.addEventListener('click', (e) => { if (e.target === host) { close(); if (opts.onCancel) opts.onCancel(); } });
    document.getElementById('cv-cancel').onclick = () => { close(); if (opts.onCancel) opts.onCancel(); };
    document.getElementById('cv-go').onclick = () => { if (refresh()) { close(); if (opts.onResolved) opts.onResolved(); } };
    refresh();
  }

  window.__parser = { fromFile, fromWorkbook, reparse, openConfig, build, discover, discoverV2, getCache: () => CACHE,
    inspect, validate, colLabel, getColumnDefs, setSessionOverride, clearSessionOverrides, openValidator };
})();
