/* ─────────────────────────────────────────────────────────────────
   report-render-v2.js — gera o deck no layout Canva A4 (V2) a partir do
   discoverV2() do report-parser.js. Estrutura espelhando a planta:
   Capa → Agenda → por campanha { Campanha → por conjunto { Conjunto →
   1 página de Anúncio por anúncio do Top } }. Reaproveita a lógica da V1:
   upload, mapear colunas, 2º Excel de plataforma, casamento de imagens,
   Configurações, navegador de páginas, edição inline e export PDF.
   ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // ── formatação BR ─────────────────────────────────────────────────
  const div = (a, b) => (b ? a / b : NaN);
  const fmtInt = (n) => Math.round(n).toLocaleString('pt-BR');
  const fmtK = (n) => (Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K' : fmtInt(n));
  const fmtCur = (n) => (isFinite(n) ? 'R$ ' + n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'NA');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = String(html).trim(); return t.content.firstElementChild; };
  const j = (o) => esc(JSON.stringify(o)); // JSON seguro p/ atributo data-* (aspas duplas; não quebra com apóstrofo)
  const ageCmp = (a, b) => { const na = parseInt(a, 10), nb = parseInt(b, 10); return (isNaN(na) ? Infinity : na) - (isNaN(nb) ? Infinity : nb); };

  const MES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const mLabel = (iso) => { const m = String(iso).match(/(\d{4})-(\d{2})-(\d{2})/); return m ? (+m[3]) + ' de ' + MES_ABBR[(+m[2]) - 1] : iso; };

  // corrige a CAIXA de nomes de marca onde aparecerem (ex.: "instagram" digitado
  // em minúsculo no nome do conjunto/anúncio → "Instagram"). Só palavras inteiras.
  const BRANDS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['whatsapp', 'WhatsApp'], ['messenger', 'Messenger'], ['threads', 'Threads'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['linkedin', 'LinkedIn'], ['pinterest', 'Pinterest'], ['google', 'Google']];
  const BRAND_MAP = BRANDS.reduce((o, b) => { o[b[0]] = b[1]; return o; }, {});
  const BRAND_RE = new RegExp('\\b(' + BRANDS.map((b) => b[0]).join('|') + ')\\b', 'gi');
  const fixBrands = (s) => String(s == null ? '' : s).replace(BRAND_RE, (m) => BRAND_MAP[m.toLowerCase()] || m);

  const labelCampaign = (name) => esc(String(name).replace(/[\[\]]/g, '').replace(/-/g, ' ').trim().toUpperCase() || 'CAMPANHA');
  // nome do conjunto RESUMIDO (padrão): prefixo numérico ou 1ºs caracteres.
  const labelConj = (name) => { const m = String(name).match(/^([0-9.]+)/); return 'CONJUNTO ' + fixBrands(m ? m[1] : String(name).trim().slice(0, 14)); };
  // nome do conjunto INTEIRO: nome completo (espaços normalizados + marcas).
  const cleanConjName = (name) => fixBrands(String(name == null ? '' : name).replace(/\s+/g, ' ').trim()) || 'Conjunto';
  // rótulo conforme o modo escolhido em Configurações (resumido x inteiro).
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

  // Versão do código (mostrada no menu). Bump a cada deploy — se o número no
  // menu não mudar depois de subir os arquivos, o navegador/servidor está
  // servindo JS de cache (atualize com Ctrl+F5).
  const APP_VERSION = '2026.06.08-4';

  let DISCOVERED = null, CONFIG = null, editing = true, PLATFORM_DATA = null;

  // ── ícones reutilizáveis ──────────────────────────────────────────
  // Logo do rodapé (canto inferior direito). Para TROCAR de logo: suba o novo PNG
  // com um NOME NOVO em assets/ (ex.: logo-tavares-2.png), atualize o caminho aqui
  // e suba o APP_VERSION acima. O nome novo força o navegador a baixar na hora —
  // não depende do .htaccess (que pode não revalidar imagens em subpastas).
  // onerror esconde a marca enquanto o arquivo não existir.
  const VO = '<div class="vo-mark"><img src="assets/logo-tavares.png" alt="logo" onerror="this.parentNode.style.display=\'none\'"></div>';
  // logos de marca (Simple Icons, inline p/ funcionar offline e no PDF)
  const ICO_IG = '<svg class="icon" viewBox="0 0 24 24" fill="#E4405F"><path d="M12 0C8.74 0 8.333.015 7.053.072 5.775.132 4.905.333 4.14.63c-.789.306-1.459.717-2.126 1.384S.935 3.35.63 4.14C.333 4.905.131 5.775.072 7.053.012 8.333 0 8.74 0 12s.015 3.667.072 4.947c.06 1.277.261 2.148.558 2.913.306.788.717 1.459 1.384 2.126.667.666 1.336 1.079 2.126 1.384.766.296 1.636.499 2.913.558C8.333 23.988 8.74 24 12 24s3.667-.015 4.947-.072c1.277-.06 2.148-.262 2.913-.558.788-.306 1.459-.718 2.126-1.384.666-.667 1.079-1.335 1.384-2.126.296-.765.499-1.636.558-2.913.06-1.28.072-1.687.072-4.947s-.015-3.667-.072-4.947c-.06-1.277-.262-2.149-.558-2.913-.306-.789-.718-1.459-1.384-2.126C21.319 1.347 20.651.935 19.86.63c-.765-.297-1.636-.499-2.913-.558C15.667.012 15.26 0 12 0Zm0 2.16c3.203 0 3.585.016 4.85.071 1.17.055 1.805.249 2.227.415.562.217.96.477 1.382.896.419.42.679.819.896 1.381.164.422.36 1.057.413 2.227.057 1.266.07 1.646.07 4.85s-.015 3.585-.074 4.85c-.061 1.17-.256 1.805-.421 2.227-.224.562-.479.96-.899 1.382-.419.419-.824.679-1.38.896-.42.164-1.065.36-2.235.413-1.274.057-1.649.07-4.859.07-3.211 0-3.586-.015-4.859-.074-1.171-.061-1.816-.256-2.236-.421-.569-.224-.96-.479-1.379-.899-.421-.419-.69-.824-.9-1.38-.165-.42-.359-1.065-.42-2.235-.045-1.26-.061-1.649-.061-4.844 0-3.196.016-3.586.061-4.861.061-1.17.255-1.814.42-2.234.21-.57.479-.96.9-1.381.419-.419.81-.689 1.379-.898.42-.166 1.051-.361 2.221-.421 1.275-.045 1.65-.06 4.859-.06l.045.03Zm0 3.678c-3.405 0-6.162 2.76-6.162 6.162 0 3.405 2.76 6.162 6.162 6.162 3.405 0 6.162-2.76 6.162-6.162 0-3.405-2.76-6.162-6.162-6.162ZM12 16c-2.21 0-4-1.79-4-4s1.79-4 4-4 4 1.79 4 4-1.79 4-4 4Zm7.846-10.405c0 .795-.646 1.44-1.44 1.44-.795 0-1.44-.646-1.44-1.44 0-.794.646-1.439 1.44-1.439.793-.001 1.44.645 1.44 1.439Z"/></svg>';
  const ICO_FB = '<svg class="icon" viewBox="0 0 24 24" fill="#1877F2"><path d="M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.628-5.373-12-12-12s-12 5.372-12 12c0 5.628 3.874 10.35 9.101 11.647Z"/></svg>';
  const ICO_OUTROS = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="#3c3c3c" stroke-width="1.6"><circle cx="12" cy="12" r="10"/><circle cx="7" cy="12" r="1.4" fill="#3c3c3c" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="#3c3c3c" stroke="none"/><circle cx="17" cy="12" r="1.4" fill="#3c3c3c" stroke="none"/></svg>';
  const ICO_MSG = '<svg class="icon" viewBox="0 0 24 24" fill="#0084FF"><path d="M12 0C5.374 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.654V24l4.088-2.242c1.092.301 2.246.464 3.443.464 6.626 0 12-4.974 12-11.111C24 4.974 18.626 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8l3.131 3.259L19.752 8l-6.561 6.963z"/></svg>';
  const ICO_WA = '<svg class="icon" viewBox="0 0 24 24" fill="#25D366"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.885-9.885 9.885M20.52 3.449C18.24 1.245 15.24 0 12.045 0 5.463 0 .104 5.359.101 11.943c0 2.096.547 4.142 1.588 5.945L0 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.582 0 11.94-5.359 11.944-11.945A11.86 11.86 0 0020.52 3.449"/></svg>';
  const MEGAPHONE = '<svg class="megaphone" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><rect x="10" y="14" width="34" height="22" rx="2"/><rect x="4" y="18" width="34" height="22" rx="2" fill="#fff"/><path d="M4 28h30l16-10v32l-16-10H4z" fill="#fff"/><path d="M16 40l4 12h6l-3-11"/></svg>';
  function iconFor(name) {
    const s = String(name).toLowerCase();
    if (/insta|^ig\b|feed|story|reels/.test(s)) return ICO_IG;
    if (/face|^fb\b|messenger/.test(s)) return ICO_FB;
    return ICO_OUTROS;
  }

  // ── combinadores (para mesclar conjuntos e anúncios) ──────────────
  function combineMetrics(list) {
    const s = { results: 0, spend: 0, impressions: 0, reach: 0, clicks: 0 }; let ads = 0;
    list.forEach((d) => { const m = d.metrics; s.results += m.results; s.spend += m.spend; s.impressions += m.impressions; s.reach += m.reach; s.clicks += m.clicks; ads += m.ads || 0; });
    return { results: s.results, spend: s.spend, impressions: s.impressions, reach: s.reach, clicks: s.clicks, ads, cpr: div(s.spend, s.results), cpc: div(s.spend, s.clicks), ctr: div(s.clicks, s.impressions), freq: div(s.impressions, s.reach) };
  }
  function combineDaily(list) {
    const m = new Map();
    list.forEach((d) => (d.daily || []).forEach((o) => { const g = m.get(o.date) || { spend: 0, results: 0, impr: 0 }; g.spend += o.spend; g.results += o.results; g.impr += o.impr || 0; m.set(o.date, g); }));
    return [...m.entries()].map(([date, v]) => ({ date, spend: v.spend, results: v.results, impr: v.impr })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  }
  function combineAgeGender(list) {
    const ages = new Set(), cell = new Map(), totals = {};
    list.forEach((ag) => {
      (ag.ages || []).forEach((age, i) => { ages.add(age); (ag.series || []).forEach((s) => { const k = age + '|' + s.gender; cell.set(k, (cell.get(k) || 0) + (s.values[i] || 0)); }); });
      const t = ag.totals || {}; Object.keys(t).forEach((g) => { totals[g] = totals[g] || { results: 0, spend: 0 }; totals[g].results += t[g].results; totals[g].spend += t[g].spend; });
    });
    const ageList = [...ages].sort(ageCmp);
    const order = [['male', 'Homens'], ['female', 'Mulheres']];
    if (totals.unknown && totals.unknown.results > 0) order.push(['unknown', 'Desconhecido']);
    const series = order.map(([g, name]) => ({ name, gender: g, values: ageList.map((age) => Math.round(cell.get(age + '|' + g) || 0)) }));
    return { ages: ageList, series, totals };
  }
  // desempate de anúncios (espelha o parser): resultados desc, depois MENOR gasto, depois nome.
  // Entradas do mapa: [nome, { res, spend }]. O adsList do parser vem como [nome, res, spend].
  function cmpAdEntry(x, y) { return (y[1].res - x[1].res) || (x[1].spend - y[1].spend) || String(x[0]).localeCompare(String(y[0])); }
  function mergeAdsetsV2(refs) {
    if (refs.length === 1) return refs[0];
    const metrics = combineMetrics(refs), daily = combineDaily(refs), ageGender = combineAgeGender(refs.map((r) => r.ageGender));
    const adMap = new Map();
    refs.forEach((r) => (r.ads || []).forEach((a) => { if (!adMap.has(a.name)) adMap.set(a.name, []); adMap.get(a.name).push(a); }));
    const ads = [...adMap.entries()].map(([name, lst]) => ({ name, metrics: combineMetrics(lst), daily: combineDaily(lst), ageGender: combineAgeGender(lst.map((a) => a.ageGender)), platform: [] })).sort((a, b) => b.metrics.spend - a.metrics.spend);
    const al = new Map(); refs.forEach((r) => (r.adsList || []).forEach(([n, rr, sp]) => { const g = al.get(n) || { res: 0, spend: 0 }; g.res += rr; g.spend += (sp || 0); al.set(n, g); }));
    const sorted = [...al.entries()].sort(cmpAdEntry);
    return { name: refs.map((r) => r.name).join(' + '), metrics, daily, ageGender, ads, adsList: sorted.map(([n, v]) => [n, v.res, v.spend]), top5: sorted.slice(0, 5).map(([n, v]) => ({ name: n, results: Math.round(v.res) })), adsAll: sorted.map(([n, v]) => ({ name: n, results: Math.round(v.res) })) };
  }

  // ── plataforma (vem do 2º Excel, casada por nome) ─────────────────
  function platformForCampaign(name) { if (!PLATFORM_DATA) return []; const c = PLATFORM_DATA.campaigns.find((x) => x.name === name); return c ? c.platform : []; }
  function platformForAdsets(names) {
    if (!PLATFORM_DATA) return [];
    const m = new Map();
    PLATFORM_DATA.campaigns.forEach((c) => c.adsets.forEach((a) => { if (names.indexOf(a.name) >= 0) (a.platform || []).forEach((o) => { const g = m.get(o.key) || { spend: 0, results: 0, reach: 0 }; g.spend += o.spend; g.results += o.results; g.reach += o.reach; m.set(o.key, g); }); }));
    return [...m.entries()].map(([key, v]) => ({ key, spend: v.spend, results: v.results, reach: v.reach })).sort((x, y) => y.spend - x.spend);
  }
  function platformForAd(adName) {
    if (!PLATFORM_DATA) return [];
    let found = null;
    PLATFORM_DATA.campaigns.some((c) => c.adsets.some((a) => { const ad = (a.ads || []).find((x) => x.name === adName); if (ad) { found = ad.platform; return true; } return false; }));
    return found || [];
  }
  function platformOverall() {
    if (!PLATFORM_DATA) return [];
    const m = new Map();
    PLATFORM_DATA.campaigns.forEach((c) => (c.platform || []).forEach((o) => { const g = m.get(o.key) || { spend: 0, results: 0, reach: 0 }; g.spend += o.spend; g.results += o.results; g.reach += o.reach; m.set(o.key, g); }));
    return [...m.entries()].map(([key, v]) => ({ key, spend: v.spend, results: v.results, reach: v.reach })).sort((x, y) => y.spend - x.spend);
  }

  // ── foto do profissional (skeleton quando vazia; sobe 1x e propaga) ──
  const CAM_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9a2 2 0 0 1 2-2h2l1.5-2.2h7L19 7h0a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="12.5" r="3.4"/></svg>';
  const photoEmpty = () => (CONFIG && CONFIG.profilePhoto) ? '' : ' empty';
  function applyPhoto() {
    const url = CONFIG && CONFIG.profilePhoto;
    document.querySelectorAll('#deck .pro-photo').forEach((e) => {
      if (url) { e.classList.remove('empty'); e.style.backgroundImage = 'url(' + url + ')'; e.style.backgroundSize = 'cover'; e.style.backgroundPosition = 'center'; }
      else { e.classList.add('empty'); e.style.backgroundImage = ''; }
    });
  }
  function setPhotoFromFile(file) {
    if (!file || !CONFIG) return;
    const r = new FileReader();
    r.onload = () => { CONFIG.profilePhoto = r.result; applyPhoto(); if (window.__imgPersist) window.__imgPersist.putKV('profilePhoto', r.result); const st = document.getElementById('rt-status'); if (st) st.textContent = 'Foto do profissional aplicada em todas as páginas.'; };
    r.readAsDataURL(file);
  }

  // ── peças comuns das páginas 2-7 ──────────────────────────────────
  function headHtml(kind) {
    const p = DISCOVERED.period;
    return '<div class="bar-top"></div><div class="bar-bot"></div>' +
      '<div class="head"><div class="avatar pro-photo' + photoEmpty() + '"><span class="pp-label">' + CAM_SVG + 'FOTO</span></div>' +
      '<div class="id"><div class="ctx">Relatório Mensal</div><div class="name ed" data-sync="client">' + esc(CONFIG.cover.client) + '</div>' +
      '<div class="date"><span data-sync="month">' + esc(p.month) + '</span> · <span data-sync="year">' + esc(p.year) + '</span></div></div>' +
      (kind ? '<div class="head-chip">' + esc(kind) + '</div>' : '') + '</div>';
  }
  const lineCanvas = (id, daily, metric, suffix, label) => {
    const labels = j(daily.map((o) => mLabel(o.date)));
    const values = j(daily.map((o) => metric === 'spend' ? +(+o.spend).toFixed(2) : Math.round(o.results)));
    return '<div class="chart-host chart-h2"><canvas id="' + id + '" data-chart="line" data-labels="' + labels + '" data-values="' + values + '"' +
      (suffix ? ' data-suffix="' + suffix + '"' : '') + (label ? ' data-label="' + esc(label) + '"' : '') + '></canvas></div>';
  };
  // faixas etárias e plataformas canônicas: sempre exibidas no gráfico (0 onde não há dado)
  const CANON_AGES = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
  function normAge(ag) {
    const present = (ag && ag.ages) ? ag.ages : [];
    const idxOf = {}; present.forEach((a, i) => { idxOf[a] = i; });
    const extras = present.filter((a) => CANON_AGES.indexOf(a) < 0); // ex.: "Unknown"
    const ages = CANON_AGES.concat(extras);
    let baseSeries = (ag && ag.series && ag.series.length) ? ag.series : [{ name: 'Homens', gender: 'male', values: [] }, { name: 'Mulheres', gender: 'female', values: [] }];
    // garante Homens + Mulheres mesmo sem dado
    if (!baseSeries.some((s) => s.gender === 'male')) baseSeries = [{ name: 'Homens', gender: 'male', values: [] }].concat(baseSeries);
    if (!baseSeries.some((s) => s.gender === 'female')) baseSeries = baseSeries.concat([{ name: 'Mulheres', gender: 'female', values: [] }]);
    const series = baseSeries.map((s) => ({ name: s.name, gender: s.gender, values: ages.map((a) => { const i = idxOf[a]; return (i != null && s.values[i] != null) ? s.values[i] : 0; }) }));
    return { ages, series, totals: (ag && ag.totals) || {} };
  }
  const CANON_PLAT = [['facebook', 'Facebook'], ['instagram', 'Instagram'], ['audience', 'Audience Network'], ['messenger', 'Messenger'], ['whatsapp', 'WhatsApp'], ['threads', 'Threads']];
  const platKey = (k) => { const s = String(k).toLowerCase(); if (/face|^fb\b|facebook/.test(s)) return 'facebook'; if (/insta|^ig\b/.test(s)) return 'instagram'; if (/audience/.test(s)) return 'audience'; if (/messenger/.test(s)) return 'messenger'; if (/whats/.test(s)) return 'whatsapp'; if (/thread/.test(s)) return 'threads'; return s; };
  function normPlat(arr) {
    const m = new Map();
    (arr || []).forEach((p) => { const k = platKey(p.key); const g = m.get(k) || { spend: 0, results: 0, reach: 0 }; g.spend += p.spend; g.results += p.results; g.reach += p.reach; m.set(k, g); });
    const out = [];
    CANON_PLAT.forEach(([k, label]) => { const g = m.get(k) || { spend: 0, results: 0, reach: 0 }; out.push({ key: label, spend: g.spend, results: g.results, reach: g.reach }); m.delete(k); });
    [...m.entries()].forEach(([k, g]) => { if (g.spend > 0 || g.results > 0 || g.reach > 0) out.push({ key: k, spend: g.spend, results: g.results, reach: g.reach }); });
    return out;
  }

  const demoCanvas = (id, agRaw) => {
    const ag = normAge(agRaw);
    const labels = j(ag.ages.map(String));
    const series = j(ag.series.map((s) => ({ name: s.name, values: s.values })));
    return '<div class="chart-host chart-h3"><canvas id="' + id + '" data-chart="grouped-bar" data-labels="' + labels + '" data-series="' + series + '"></canvas></div>';
  };
  function demoLegend(ag) {
    const t = ag.totals || {};
    const tot = (t.male ? t.male.results : 0) + (t.female ? t.female.results : 0) + (t.unknown ? t.unknown.results : 0);
    const row = (label, color, g) => { const o = t[g] || { results: 0, spend: 0 }; const pct = tot ? Math.round(o.results / tot * 100) : 0; return '<div><b style="color:' + color + '">■</b> ' + label + '<br>' + pct + '% (' + Math.round(o.results) + ')<br>Custo por resultado: ' + fmtCur(div(o.spend, o.results)) + '</div>'; };
    return '<div class="det-legend">' + row('Homens', 'var(--purple)', 'male') + row('Mulheres', 'var(--teal)', 'female') + '</div>';
  }
  function platBlock(id, plat) {
    const hasPlat = plat && plat.length;
    const np = hasPlat ? normPlat(plat) : [];
    const left = hasPlat
      ? '<div class="chart-host chart-h4"><canvas id="' + id + '" data-chart="grouped-bar-dual" data-labels="' +
          j(np.map((p) => p.key)) + '" data-series="' +
          j([{ name: 'Alcance', values: np.map((p) => Math.round(p.reach)) }, { name: 'Resultados', values: np.map((p) => Math.round(p.results)) }]) + '"></canvas></div>'
      : '<div class="plat-ph">' + (PLATFORM_DATA ? 'Sem dados de plataforma para este item (não casou por nome com o 2º Excel).' : 'Disponível ao subir o 2º Excel (relatório de plataforma).') + '</div>';
    // 5 linhas fixas: Instagram, Facebook, Messenger, WhatsApp e Outros (soma do restante)
    const spendOf = (lbl) => { const p = np.find((x) => x.key === lbl); return p ? p.spend : 0; };
    const named = ['Instagram', 'Facebook', 'Messenger', 'WhatsApp'];
    const outrosS = np.filter((p) => named.indexOf(p.key) < 0).reduce((a, p) => a + p.spend, 0);
    const rrow = (ico, name, val) => '<div class="row">' + ico + '<div><div class="val">' + fmtCur(val) + '</div><div class="pname">' + name + '</div></div></div>';
    const rows = hasPlat
      ? (rrow(ICO_IG, 'Instagram', spendOf('Instagram')) + rrow(ICO_FB, 'Facebook', spendOf('Facebook')) +
         rrow(ICO_MSG, 'Messenger', spendOf('Messenger')) + rrow(ICO_WA, 'WhatsApp', spendOf('WhatsApp')) +
         rrow(ICO_OUTROS, 'Outros', outrosS))
      : '<div class="plat-empty">' + (PLATFORM_DATA ? 'Sem dados de plataforma para este item.' : 'Sem dados de plataforma — suba o 2º Excel (plataforma).') + '</div>';
    return '<div class="det-plat">' +
      '<div><div class="sec-lbl">Posicionamento por plataforma</div>' + left + '</div>' +
      '<div class="det-plat-divider"></div>' +
      '<div class="col-r"><div class="sec-lbl" style="margin:0">Valor gasto por plataforma</div>' + rows + '</div></div>';
  }
  // bloco compacto de plataforma usado na agenda (prévia explicativa)
  function agPlatBlock(plat) {
    const hasPlat = plat && plat.length;
    const np = hasPlat ? normPlat(plat) : [];
    const left = hasPlat
      ? '<div class="chart-host"><canvas data-chart="grouped-bar-mute" data-labels="' + j(np.map((p) => p.key)) + '" data-series="' +
          j([{ name: 'Alcance', values: np.map((p) => Math.round(p.reach)) }, { name: 'Resultados', values: np.map((p) => Math.round(p.results)) }]) + '"></canvas></div>'
      : '<div class="plat-ph">Aparece aqui ao subir o 2º Excel (relatório de plataforma).</div>';
    // valores são apenas exemplo (skeleton) — a pág. 2 é uma legenda, não mostra dados reais
    const rrow = (ico, name) => '<div class="row">' + ico + '<div><div class="val"><span class="ag-skel ag-skel-val"></span></div><div class="pname">' + name + '</div></div></div>';
    const rows = rrow(ICO_IG, 'Instagram') + rrow(ICO_FB, 'Facebook') + rrow(ICO_MSG, 'Messenger') + rrow(ICO_WA, 'WhatsApp') + rrow(ICO_OUTROS, 'Outros');
    return '<div class="ag-plat">' +
      '<div class="ag-plat-chart"><div class="sec-lbl">Posicionamento por plataforma</div>' + left +
      '<div class="bubble tc ag-bubble-4">Em quais plataformas os anúncios apareceram — alcance e resultados.</div></div>' +
      '<div class="ag-plat-div"></div>' +
      '<div class="ag-plat-vals"><div class="sec-lbl" style="margin:0">Valor gasto por plataforma</div>' + rows +
      '<div class="bubble tc ag-bubble-5">Quanto do orçamento foi investido em cada plataforma.</div></div></div>';
  }
  const kpiCard = (lbl, val, kind) => '<div class="kpi-card" data-kind="' + esc(kind) + '"><div class="kpi-lbl">' + esc(lbl) + '</div><div class="kpi-val ed">' + esc(val) + '</div></div>';

  // ── 01 · Capa ─────────────────────────────────────────────────────
  function buildCover() {
    const p = DISCOVERED.period;
    return el('<section data-screen-label="01 Capa">' +
      '<div class="cover-portrait pro-photo' + photoEmpty() + '"><span class="pp-label">' + CAM_SVG + 'Inserir foto<br>do profissional</span></div>' +
      '<div class="cover-name ed" data-sync="client">' + esc(CONFIG.cover.client) + '</div><div class="cover-name-rule"></div>' +
      '<div class="cover-agency ed">' + esc(CONFIG.cover.agency) + '</div>' +
      '<div class="cover-title"><span class="row">RELATÓRIO</span><span class="row">MENSAL</span></div>' +
      '<div class="cover-rule"></div>' +
      '<div class="cover-date"><span class="ed" data-sync="month">' + esc(p.month) + '</span><span class="ed" data-sync="year">' + esc(p.year) + '</span></div></section>');
  }

  // ── 02 · Agenda (visão geral resumida) ────────────────────────────
  function buildAgenda() {
    const inc = CONFIG.campaigns.filter((c) => c.include).map((c) => c.ref);
    const src = inc.length ? inc : DISCOVERED.campaigns;
    const dailyAll = combineDaily(src);
    const agAll = combineAgeGender(src.map((c) => c.ageGender));
    const lineMini = '<div class="chart-host chart-h2"><canvas data-chart="line-mute" data-labels="' + j(dailyAll.map((o) => mLabel(o.date))) + '" data-values="' + j(dailyAll.map((o) => Math.round(o.results))) + '"></canvas></div>';
    const agN = normAge(agAll);
    const demoMini = '<div class="chart-host"><canvas data-chart="grouped-bar-mute" data-labels="' + j(agN.ages.map(String)) + '" data-series="' + j(agN.series.map((s) => ({ name: s.name, values: s.values }))) + '"></canvas></div>';
    const platAll = platformOverall();
    return el('<section data-screen-label="02 Agenda">' + headHtml() +
      '<div class="ag-head-eyebrow">Estatísticas por Anúncio <em>*Ordem Decrescente</em></div>' +
      '<div class="ag-head-title">O que você encontrará adiante?<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="M21 21l-5-5"></path></svg></div>' +
      '<div class="ag-stage">' +
      '<div class="ag-top">' +
      '<div class="ag-mini"><svg class="icon" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="2"><rect x="8" y="14" width="48" height="36" rx="2"/><circle cx="22" cy="28" r="4"/><path d="M8 46l14-14 12 12 8-6 14 10"/></svg><div class="lbl">MINIATURA<br>DO ANÚNCIO</div></div>' +
      '<div class="ag-overview">' +
      '<div class="sec-lbl">Visão geral do desempenho</div>' +
      '<div class="kpi-row">' +
      '<div class="kpi-card"><div class="kpi-lbl">Resultados</div><div class="kpi-val"><span class="ag-skel ag-skel-kpi"></span></div></div>' +
      '<div class="kpi-card"><div class="kpi-lbl">Custo por resultado</div><div class="kpi-val"><span class="ag-skel ag-skel-kpi"></span></div></div>' +
      '<div class="kpi-card"><div class="kpi-lbl">Valor gasto</div><div class="kpi-val"><span class="ag-skel ag-skel-kpi"></span></div></div></div>' +
      '<div class="sec-lbl" style="margin-top:5px">Resultados ao longo do período</div>' +
      '<div class="ag-chart-wrap">' + lineMini +
      '<div class="bubble tl ag-bubble-1">Números, custos e indicadores de ocorrência ao longo do período.</div></div>' +
      '</div></div>' +
      '<div class="ag-demo"><div class="sec-lbl">Distribuição por gênero e idade</div>' + demoMini +
      '<div class="bubble tl ag-bubble-2">Dados e Informações Demográficas extraídas do público dos anúncios.</div>' +
      '<div class="bubble tl ag-bubble-3">Percentual Gênero × Custo</div></div>' +
      agPlatBlock(platAll) +
      '</div>' +
      '<div class="ag-foot">* Anúncios exibidos considerando o valor consumido no período, do maior consumo de orçamento para o menor.</div>' + VO + '</section>');
  }

  // ── 03 · Campanha ─────────────────────────────────────────────────
  function buildCampanha(cc, ci) {
    const m = cc.ref.metrics, rt = cc.ref.resultType || 'Resultados';
    return el('<section data-screen-label="Campanha ' + esc(cc.label) + '">' + headHtml('Campanha') +
      '<div class="det-title ed">' + esc(cc.label) + '</div>' +
      '<div class="det-sub ed">Campanha <b>' + esc(cc.label) + '</b> — objetivo de <b>' + esc(rt) + '</b>. A seguir: visão geral (resultados, custo por resultado e valor gasto), evolução diária dos resultados, público por gênero e idade e desempenho por plataforma.</div>' +
      '<div class="det-top"><div class="det-card-thumb">' + MEGAPHONE + '<div class="cap ed">Campanha de<br>' + esc(rt) + '</div></div>' +
      '<div class="det-overview"><div class="sec-lbl">Visão geral do desempenho</div>' +
      '<div class="kpi-row">' + kpiCard(rt, fmtInt(m.results), 'resultados') + kpiCard('Custo por resultado', fmtCur(m.cpr), 'custo_resultado') + kpiCard('Valor gasto', fmtCur(m.spend), 'valor') + '</div>' +
      '<div class="sec-lbl" style="margin-top:8px">' + esc(rt) + '</div>' + lineCanvas('v2c' + ci + '-line', cc.ref.daily, 'results', '', rt) + '</div></div>' +
      '<div class="det-demo"><div class="sec-lbl">Distribuição por gênero e idade <span class="sec-sub">— barras = nº de resultados (' + esc(rt) + ')</span></div>' + demoCanvas('v2c' + ci + '-demo', cc.ref.ageGender) + demoLegend(cc.ref.ageGender) + '</div>' +
      platBlock('v2c' + ci + '-plat', platformForCampaign(cc.ref.name)) + VO + '</section>');
  }

  // ── 04 · Conjunto ─────────────────────────────────────────────────
  function buildConjunto(cc, cj, m, ci, si) {
    const rt = cc.ref.resultType || 'Resultados';
    const id = 'v2c' + ci + 's' + si;
    const disp = dispConj(cc, cj); // "TAG-CAMPANHA | NOME DO CONJUNTO"
    return el('<section data-screen-label="' + esc(disp) + '">' + headHtml('Conjunto') +
      '<div class="det-title ed">' + esc(disp) + '</div>' +
      '<div class="det-sub ed">Conjunto <b>' + esc(cj.label) + '</b> da campanha ' + esc(cc.label) + '. A seguir: principais métricas (' + esc(rt) + ', custo por resultado e valor gasto), evolução diária, público por gênero e idade e desempenho por plataforma.</div>' +
      '<div class="det-top"><div class="det-card-thumb">' + MEGAPHONE + '<div class="cap ed">Conjunto</div></div>' +
      '<div class="det-overview"><div class="sec-lbl">Visão geral do desempenho</div>' +
      '<div class="kpi-row">' + kpiCard(rt, fmtInt(m.metrics.results), 'resultados') + kpiCard('Custo por resultado', fmtCur(m.metrics.cpr), 'custo_resultado') + kpiCard('Valor gasto', fmtCur(m.metrics.spend), 'valor') + '</div>' +
      '<div class="sec-lbl" style="margin-top:8px">' + esc(rt) + '</div>' + lineCanvas(id + '-line', m.daily, 'results', '', rt) + '</div></div>' +
      '<div class="det-demo"><div class="sec-lbl">Distribuição por gênero e idade <span class="sec-sub">— barras = nº de resultados (' + esc(rt) + ')</span></div>' + demoCanvas(id + '-demo', m.ageGender) + demoLegend(m.ageGender) + '</div>' +
      platBlock(id + '-plat', platformForAdsets(cj.refs.map((r) => r.name))) + VO + '</section>');
  }

  // ── 05+ · Anúncio (1 página por anúncio do Top) ───────────────────
  function buildAnuncio(cc, cj, det, scope, idp) {
    const m = det.metrics, rt = cc.ref.resultType || 'Resultados';
    const adName = fixBrands(det.name); // grafia corrigida só p/ exibição (matching usa det.name)
    const titleFs = adName.length > 26 ? (adName.length > 36 ? 30 : 34) : 42;
    const del = '<button class="ad-del" data-exa="' + esc(det.name) + '" data-ci="' + scope.ci + '" data-si="' + scope.si + '" title="Remover este anúncio" type="button">×</button>';
    return el('<section data-screen-label="Anúncio ' + esc(adName) + '">' + headHtml('Anúncio') + del +
      '<div class="det-title ed" style="font-size:' + titleFs + 'px">' + esc(adName) + '</div>' +
      '<div class="det-sub ed">Anúncio <b>' + esc(adName) + '</b>. A seguir: métricas individuais (' + esc(rt) + ', custo por resultado e valor gasto), evolução diária, público por gênero e idade e desempenho por plataforma.</div>' +
      '<div class="det-top"><div class="ad-thumb"><image-slot id="' + idp + '" data-ad="' + esc(det.name) + '" placeholder="thumb"></image-slot></div>' +
      '<div class="det-overview"><div class="sec-lbl">Visão geral do desempenho</div>' +
      '<div class="kpi-row">' + kpiCard(rt, fmtInt(m.results), 'resultados') + kpiCard('Custo por resultado', fmtCur(m.cpr), 'custo_resultado') + kpiCard('Valor gasto', fmtCur(m.spend), 'valor') + '</div>' +
      '<div class="sec-lbl" style="margin-top:8px">' + esc(rt) + '</div>' + lineCanvas(idp + '-line', det.daily, 'results', '', rt) + '</div></div>' +
      '<div class="det-demo"><div class="sec-lbl">Distribuição por gênero e idade <span class="sec-sub">— barras = nº de resultados (' + esc(rt) + ')</span></div>' + demoCanvas(idp + '-demo', det.ageGender) + demoLegend(det.ageGender) + '</div>' +
      platBlock(idp + '-plat', platformForAd(det.name)) + VO + '</section>');
  }

  // ── config inicial ────────────────────────────────────────────────
  function buildConfig(d) {
    return {
      cover: { client: 'Cliente', agency: 'FÁBIO TAVARES' },
      profilePhoto: null,
      hidden: [], hiddenKinds: [],
      fullConjNames: false, // false = nome do conjunto resumido (padrão); true = nome inteiro
      campaigns: d.campaigns.map((c) => ({
        ref: c, label: labelCampaign(c.name), include: true,
        conjuntos: c.adsets.map((a) => ({ refs: [a], label: labelConj(a.name), labelAuto: true, include: true })),
      })),
    };
  }

  // ── persistência das EDIÇÕES (sem os dados do Excel) — espelha a V1 ──
  // Conjuntos guardados pelos NOMES dos adsets, p/ re-casar com o Excel ao
  // restaurar/importar. A foto do profissional NÃO entra aqui (já persiste à
  // parte via __imgPersist.putKV('profilePhoto')).
  function serializeConfig(cfg) {
    if (!cfg) return null;
    return {
      v: 1, kind: 'v2',
      cover: cfg.cover, fullConjNames: cfg.fullConjNames,
      hidden: cfg.hidden, hiddenKinds: cfg.hiddenKinds,
      campaigns: (cfg.campaigns || []).map((cc) => ({
        name: cc.ref.name, label: cc.label, include: cc.include,
        conjuntos: (cc.conjuntos || []).map((cj) => ({
          adsets: cj.refs.map((r) => r.name), label: cj.label, labelAuto: cj.labelAuto, include: cj.include,
          top5Override: cj.top5Override || null, exclAds: cj.exclAds || null,
        })),
      })),
    };
  }
  function applyConfigSnapshot(snap, d) {
    const base = buildConfig(d);
    if (!snap || snap.kind !== 'v2') return base;
    if (snap.cover) base.cover = Object.assign({}, base.cover, snap.cover);
    if ('fullConjNames' in snap) base.fullConjNames = !!snap.fullConjNames;
    if (Array.isArray(snap.hidden)) base.hidden = snap.hidden.slice();
    if (Array.isArray(snap.hiddenKinds)) base.hiddenKinds = snap.hiddenKinds.slice();
    const byName = new Map(base.campaigns.map((c) => [c.ref.name, c]));
    const used = new Set(), ordered = [];
    (snap.campaigns || []).forEach((sc) => {
      const cc = byName.get(sc.name); if (!cc) return;
      used.add(sc.name);
      if (sc.label != null) cc.label = sc.label;
      cc.include = sc.include !== false;
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
  const CFG_TTL_MS = 2 * 60 * 60 * 1000;
  let _cfgSaveT = null;
  function saveConfigSoon() {
    if (!CONFIG || !window.__imgPersist) return;
    clearTimeout(_cfgSaveT);
    _cfgSaveT = setTimeout(() => {
      try { window.__imgPersist.putKV('reportCfgV2', { savedAt: Date.now(), snap: serializeConfig(CONFIG) }); } catch (e) {}
    }, 1000);
  }
  async function maybeRestoreConfig(d) {
    if (!window.__imgPersist) return null;
    try {
      const saved = await window.__imgPersist.getKV('reportCfgV2');
      if (!saved || !saved.snap || (Date.now() - saved.savedAt) >= CFG_TTL_MS) return null;
      const def = JSON.stringify(serializeConfig(buildConfig(d)));
      if (JSON.stringify(saved.snap) === def) return null;
      const mins = Math.max(1, Math.round((Date.now() - saved.savedAt) / 60000));
      if (window.confirm('Encontrei ajustes deste relatório salvos há ~' + mins + ' min. Restaurar a última versão?\n\n(Cancelar = começar do zero.)')) {
        return applyConfigSnapshot(saved.snap, d);
      }
    } catch (e) {}
    return null;
  }
  function exportConfig() {
    const snap = serializeConfig(CONFIG); if (!snap) return;
    const tag = (DISCOVERED && DISCOVERED.period) ? (DISCOVERED.period.month + '-' + DISCOVERED.period.year) : 'v2';
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'relatorio-config-v2-' + tag + '.json';
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
        if (!snap || snap.kind !== 'v2') { alert('Arquivo de configuração inválido (esperado um perfil da V2).'); return; }
        CONFIG = applyConfigSnapshot(snap, DISCOVERED);
        const bd = document.getElementById('cfg-backdrop'); if (bd) bd.remove();
        render();
        const st = document.getElementById('rt-status'); if (st) st.textContent = 'Configuração importada do arquivo.';
      };
      r.readAsText(f);
    };
    inp.click();
  }

  function topForConj(cj, m) {
    const ex = cj.exclAds || [];
    const base = cj.top5Override || m.adsAll || m.top5 || [];
    return base.filter((a) => ex.indexOf(a.name) < 0).slice(0, 5);
  }
  function adFallback(ad) { return { name: ad.name, metrics: { results: ad.results, spend: NaN, cpr: NaN }, daily: [], ageGender: { ages: [], series: [], totals: {} }, platform: [] }; }

  // ── render ────────────────────────────────────────────────────────
  function render() {
    const deck = document.getElementById('deck');
    // destrói gráficos antigos ANTES de limpar (evita vazamento do Chart.js a cada re-render)
    deck.querySelectorAll('canvas').forEach((c) => { if (c.__chart) { c.__chart.destroy(); c.__chart = null; } });
    deck.innerHTML = '';
    const secs = [];
    const push = (sec, group) => { if (sec) { sec.dataset.group = group; secs.push(sec); } };
    push(buildCover(), 'Geral'); push(buildAgenda(), 'Geral');
    CONFIG.campaigns.forEach((cc, ci) => {
      if (!cc.include) return;
      const g = 'Campanha · ' + cc.label;
      push(buildCampanha(cc, ci), g);
      cc.conjuntos.forEach((cj, si) => {
        if (!cj.include) return;
        const cg = 'Conjunto · ' + dispConj(cc, cj);
        const m = mergeAdsetsV2(cj.refs);
        push(buildConjunto(cc, cj, m, ci, si), cg);
        const tops = topForConj(cj, m);
        tops.forEach((ad, ai) => {
          const det = (m.ads || []).find((a) => a.name === ad.name) || adFallback(ad);
          push(buildAnuncio(cc, cj, det, { ci, si }, 'v2c' + ci + 's' + si + 'a' + ai), cg);
        });
      });
    });
    secs.forEach((s) => deck.appendChild(s));
    const hk = CONFIG.hiddenKinds || [];
    if (hk.length) [...deck.querySelectorAll('[data-kind]')].forEach((e) => { if (hk.indexOf(e.getAttribute('data-kind')) >= 0) e.remove(); });
    buildNav();
    saveConfigSoon(); // cache curto das edições (2h), por relatório
    setTimeout(() => {
      if (window.__renderCharts) window.__renderCharts(); applyPhoto(); fitKpis(); fitDetTitles(); setEditing(editing); hideDeckOverlay(); updatePager();
      applyZoom(); // mantém o nível de zoom atual (padrão 200%) após cada render
      if (!_zoomCentered) { // na 1ª vez, centraliza horizontalmente e alinha ao topo
        _zoomCentered = true;
        const w = document.getElementById('zoomwrap');
        if (w) { w.scrollLeft = Math.max(0, (w.scrollWidth - w.clientWidth) / 2); w.scrollTop = 0; }
      }
    }, 60);
  }

  // ajuste de fonte por célula: número grande encolhe pra caber no card (a V2
  // não tinha o fit-numbers da V1; valores longos como "R$ 1.234.567,89" vazavam)
  function fitKpis() {
    document.querySelectorAll('#deck .kpi-card .kpi-val').forEach((elx) => {
      const card = elx.closest('.kpi-card'); if (!card) return;
      const cs = getComputedStyle(card);
      const avail = card.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0);
      if (!avail) return;
      let base = parseFloat(elx.dataset.baseFs);
      if (!base) { base = parseFloat(getComputedStyle(elx).fontSize); elx.dataset.baseFs = base; }
      elx.style.whiteSpace = 'nowrap'; elx.style.fontSize = base + 'px';
      let size = base; const min = base * 0.5; let g = 0;
      while (elx.scrollWidth > avail + 0.5 && size > min && g < 60) { size -= 1; elx.style.fontSize = size + 'px'; g++; }
    });
  }
  // título (campanha/conjunto/anúncio): encolhe a fonte p/ caber até a descrição,
  // mesmo com "nome inteiro" do conjunto ou nomes longos com caracteres especiais.
  function fitDetTitles() {
    document.querySelectorAll('#deck .det-title').forEach((elx) => {
      if (!elx.clientWidth) return;
      let base = parseFloat(elx.dataset.baseFs);
      if (!base) { base = parseFloat(getComputedStyle(elx).fontSize) || 48; elx.dataset.baseFs = base; }
      const budget = 84; // px até a descrição (det-sub @368 − det-title @282)
      let size = base; elx.style.fontSize = size + 'px';
      let g = 0;
      while (size > 18 && elx.scrollHeight > budget && g < 60) { size -= 1; elx.style.fontSize = size + 'px'; g++; }
    });
  }
  // re-ajusta ao editar um KPI/título e quando as fontes terminam de carregar
  document.addEventListener('blur', (e) => { const cl = e.target && e.target.classList; if (!cl) return; if (cl.contains('kpi-val')) fitKpis(); if (cl.contains('det-title')) fitDetTitles(); }, true);
  if (document.fonts) document.fonts.ready.then(() => setTimeout(() => { fitKpis(); fitDetTitles(); }, 120));

  // clicar na foto do profissional (modo edição) abre o seletor de imagem
  document.addEventListener('click', (e) => {
    const p = e.target.closest && e.target.closest('#deck .pro-photo');
    if (!p || !editing) return;
    e.preventDefault();
    const inp = document.getElementById('rt-photo'); if (inp) inp.click();
  });

  // ── sincronizar nome do cliente (sempre) e mês (perguntando) entre páginas ──
  function syncAll(kind, val) {
    document.querySelectorAll('#deck [data-sync="' + kind + '"]').forEach((e) => { if (e.textContent !== val) e.textContent = val; });
  }
  document.addEventListener('blur', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.dataset.sync || !CONFIG || !DISCOVERED) return;
    const kind = t.dataset.sync, val = (t.textContent || '').trim();
    if (kind === 'client') { CONFIG.cover.client = val; syncAll('client', val); }
    else if (kind === 'year') { DISCOVERED.period.year = val; syncAll('year', val); }
    else if (kind === 'month') {
      if (val && val !== DISCOVERED.period.month) {
        if (window.confirm('Aplicar o mês "' + val + '" em todas as páginas?')) { DISCOVERED.period.month = val; syncAll('month', val); }
      }
    }
  }, true);

  // ── zoom das páginas (wrapper rolável + CSS zoom no host do deck) ──
  // Padrão 200% (pedido do usuário): o relatório abre ampliado; "Ajustar" volta a 100%.
  let ZOOM = 2, _zoomCentered = false;
  function applyZoom() {
    const deck = document.getElementById('deck'); if (!deck) return;
    if (ZOOM <= 1.001) { deck.style.zoom = ''; deck.style.position = ''; deck.style.width = ''; deck.style.height = ''; }
    else { deck.style.position = 'relative'; deck.style.width = '100vw'; deck.style.height = '100vh'; deck.style.zoom = String(ZOOM); }
    const lbl = document.getElementById('zoom-lbl'); if (lbl) lbl.textContent = ZOOM <= 1.001 ? 'Ajustar' : Math.round(ZOOM * 100) + '%';
    const wrap = document.getElementById('zoomwrap'); if (wrap) wrap.classList.toggle('pannable', ZOOM > 1.001);
  }
  // Aplica o zoom mantendo o ponto central do que está visível ancorado, em vez
  // de crescer a partir do canto superior-esquerdo (que jogava o relatório pra
  // fora da tela). Em zoom=1 não há overflow → ancora em 0.5/0.5 = centralizado.
  function setZoom(z) {
    const wrap = document.getElementById('zoomwrap');
    let ax = 0.5, ay = 0.5;
    if (wrap) {
      if (wrap.scrollWidth > wrap.clientWidth) ax = (wrap.scrollLeft + wrap.clientWidth / 2) / wrap.scrollWidth;
      if (wrap.scrollHeight > wrap.clientHeight) ay = (wrap.scrollTop + wrap.clientHeight / 2) / wrap.scrollHeight;
    }
    ZOOM = Math.max(1, Math.min(3, Math.round(z * 100) / 100));
    applyZoom();
    if (wrap) {
      wrap.scrollLeft = Math.max(0, ax * wrap.scrollWidth - wrap.clientWidth / 2);
      wrap.scrollTop = Math.max(0, ay * wrap.scrollHeight - wrap.clientHeight / 2);
    }
  }
  // imprimir sempre em 100% (zoom + wrapper confinariam a paginação a 1 página)
  window.addEventListener('beforeprint', () => { if (ZOOM !== 1) setZoom(1); });

  // ── arrastar a página com o mouse (grab-to-pan) ───────────────────
  // Só atua com zoom (>1). Ignora controles e, em modo edição, os elementos
  // editáveis/clicáveis — para não atrapalhar seleção de texto, upload de foto
  // e os criativos.
  function enablePan() {
    const wrap = document.getElementById('zoomwrap');
    if (!wrap || wrap.__panOn) return; wrap.__panOn = true;
    let armed = false, panning = false, sx = 0, sy = 0, sl = 0, st = 0;
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || ZOOM <= 1.001) return;
      // não sequestrar os controles; o resto (texto, gráficos, fundo) pode arrastar
      if (e.target.closest && e.target.closest('button, input, textarea, select, a')) return;
      armed = true; panning = false;
      sx = e.clientX; sy = e.clientY; sl = wrap.scrollLeft; st = wrap.scrollTop;
    });
    window.addEventListener('mousemove', (e) => {
      if (!armed) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!panning) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;   // ainda é clique, não arrasto
        panning = true; wrap.classList.add('grabbing');
      }
      // arrastando → vira pan: cancela seleção de texto nativa e move o scroll
      const sel = window.getSelection && window.getSelection();
      if (sel && sel.rangeCount) { try { sel.removeAllRanges(); } catch (_) {} }
      e.preventDefault();
      wrap.scrollLeft = sl - dx; wrap.scrollTop = st - dy;
    });
    const end = () => { armed = false; if (panning) { panning = false; wrap.classList.remove('grabbing'); } };
    window.addEventListener('mouseup', end);
    window.addEventListener('blur', end);
  }

  // ── navegação de páginas na barra única #deck-bar ─────────────────
  let CUR = 0;
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

  // ── remover anúncio (× no canto da página, modo edição) ───────────
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('.ad-del');
    if (!b || !CONFIG) return;
    e.preventDefault(); e.stopPropagation();
    const cj = CONFIG.campaigns[+b.dataset.ci].conjuntos[+b.dataset.si];
    if (cj) { cj.exclAds = cj.exclAds || []; if (cj.exclAds.indexOf(b.dataset.exa) < 0) cj.exclAds.push(b.dataset.exa); render(); }
  }, true);

  // ── restaurar tudo que foi removido/ocultado ──────────────────────
  // Limpa: anúncios excluídos (×), top-5 manual, campanhas/conjuntos
  // desmarcados em Configurações e tipos de dado ocultos. Volta ao estado
  // cheio do relatório.
  function resetExclusions() {
    if (!CONFIG) return;
    let n = 0;
    (CONFIG.campaigns || []).forEach((cc) => {
      if (cc.include === false) { cc.include = true; n++; }
      (cc.conjuntos || []).forEach((cj) => {
        if (cj.include === false) { cj.include = true; n++; }
        if (cj.exclAds && cj.exclAds.length) { n += cj.exclAds.length; delete cj.exclAds; }
        if (cj.top5Override) { delete cj.top5Override; n++; }
      });
    });
    if (CONFIG.hiddenKinds && CONFIG.hiddenKinds.length) { n += CONFIG.hiddenKinds.length; CONFIG.hiddenKinds = []; }
    if (CONFIG.hidden && CONFIG.hidden.length) { CONFIG.hidden = []; }
    render();
    const st = document.getElementById('rt-status');
    if (st) st.textContent = n ? ('Restaurado: ' + n + ' item(ns) que estavam removidos/ocultos voltaram.') : 'Nada para restaurar — nenhum campo estava removido.';
  }

  // ── navegador de páginas ──────────────────────────────────────────
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
    if (drawer.classList.contains('open')) materializeThumbs();
  }
  function materializeThumbs() {
    if (navMaterialized) return;
    navMaterialized = true;
    const drawer = document.getElementById('nav-drawer');
    const slides = [...document.querySelectorAll('#deck > section')];
    drawer.querySelectorAll('.nav-item').forEach((item) => {
      const i = +item.dataset.i, s = slides[i], frame = item.querySelector('.nav-frame');
      if (!s || !frame) return;
      try {
        const clone = s.cloneNode(true);
        clone.removeAttribute('id'); clone.removeAttribute('data-screen-label');
        clone.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
        // a miniatura é só para navegar: tira os controles de exclusão (× de
        // anúncio/KPI) para ninguém apagar dados clicando sem querer nela.
        clone.querySelectorAll('.ad-del, .kpi-hide, .cr-del').forEach((e) => e.remove());
        clone.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
        clone.style.cssText = 'position:absolute;top:0;left:0;width:1240px;height:1754px;overflow:hidden;background:#fff;';
        const oc = s.querySelectorAll('canvas'), cc = clone.querySelectorAll('canvas');
        oc.forEach((o, k) => { let url = ''; try { url = o.toDataURL(); } catch (e) {} const img = document.createElement('img'); img.src = url; img.style.cssText = 'width:100%;height:100%;object-fit:contain'; if (cc[k]) cc[k].replaceWith(img); });
        const os = s.querySelectorAll('image-slot'), csl = clone.querySelectorAll('image-slot');
        os.forEach((o, k) => { const im = o.shadowRoot && o.shadowRoot.querySelector('img'); const src = im ? im.src : ''; const d = document.createElement('div'); d.style.cssText = 'width:100%;height:100%;background:#ddd ' + (src ? 'center/cover no-repeat' : '') + ';' + (src ? 'background-image:url(' + src + ')' : ''); if (csl[k]) csl[k].replaceWith(d); });
        // wrapper recebe a classe .v2deck para que o CSS da V2 (escopado em
        // .v2deck) estilize a página clonada — sem isso o clone fica sem layout
        // e só sobra a foto de fundo do .pro-photo (bug das miniaturas iguais).
        const scale = document.createElement('div'); scale.className = 'nav-scale v2deck'; scale.appendChild(clone);
        frame.classList.remove('loading'); frame.innerHTML = ''; frame.appendChild(scale);
        scale.style.transform = 'scale(' + (frame.clientWidth / 1240) + ')';
      } catch (e) { frame.classList.remove('loading'); }
    });
  }
  document.addEventListener('click', (e) => {
    const it = e.target.closest && e.target.closest('#nav-drawer .nav-item');
    if (!it) return;
    const deck = document.getElementById('deck');
    if (deck && deck._go) deck._go(+it.dataset.i, 'thumb');
  });
  window.addEventListener('message', (e) => {
    const d = e.data;
    if (d && typeof d.slideIndexChanged === 'number') {
      CUR = d.slideIndexChanged;
      updatePager();
      document.querySelectorAll('#nav-drawer .nav-item').forEach((x) => x.classList.toggle('current', +x.dataset.i === d.slideIndexChanged));
    }
  });

  // ── edição inline ─────────────────────────────────────────────────
  function setEditing(on) {
    editing = on;
    document.querySelectorAll('#deck .ed').forEach((e) => { e.contentEditable = on ? 'true' : 'false'; e.spellcheck = false; });
    document.body.classList.toggle('rt-editing', on);
    const btn = document.getElementById('rt-edit'); if (btn) btn.textContent = 'Editar: ' + (on ? 'ON' : 'OFF');
  }
  document.body.classList.add('rt-editing');

  // ── upload do relatório principal ─────────────────────────────────
  // ── Campos obrigatórios para validar o upload (V2) ──────────────────
  // Bloqueia só o que a V2 EXIBE: KPIs Resultados + Valor gasto, gráfico de
  // linha diária (Dia) e o gráfico Idade×Gênero por anúncio (Idade/Gênero).
  // V2 NÃO mostra Impressões/Alcance/Cliques no principal → não bloqueiam aqui
  // (Alcance/Impressões da plataforma vêm do Relatório 2). "Tipo de resultado"
  // só recomendado (dá o rótulo do objetivo).
  const REQ_MAIN = ['campaign', 'adset', 'ad', 'results', 'spend', 'start', 'age', 'gender'];
  const WARN_MAIN = ['result_type'];
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
          try { window.__parser.fromWorkbook(wb); } catch (e) {}
          DISCOVERED = window.__parser.discoverV2(headers, rows);
          // namespace das imagens/config por relatório (impressão digital do Excel)
          window.__slotNS = (file.name || 'rep') + '|' + (file.size || 0) + '|' + (file.lastModified || 0);
          CONFIG = (await maybeRestoreConfig(DISCOVERED)) || buildConfig(DISCOVERED);
          render();
          if (window.__slotsReload) window.__slotsReload(window.__slotNS);
          if (window.__imgPersist) window.__imgPersist.getKV('profilePhoto').then((u) => { if (u && CONFIG) { CONFIG.profilePhoto = u; applyPhoto(); } });
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

  // ── 2º Excel (plataforma) ─────────────────────────────────────────
  function validatePlatform(P) {
    const w = [], D = DISCOVERED;
    const pct = (a, b) => (b ? Math.abs(a - b) / b : (a ? 1 : 0));
    if (P.period.month !== D.period.month || P.period.year !== D.period.year) w.push('Período diferente: principal ' + D.period.month + '/' + D.period.year + ' × plataforma ' + P.period.month + '/' + P.period.year);
    if (pct(P.overall.spend, D.overall.spend) > 0.05) w.push('Investimento total difere ' + (pct(P.overall.spend, D.overall.spend) * 100).toFixed(0) + '%');
    if (pct(P.overall.impressions, D.overall.impressions) > 0.05) w.push('Impressões diferem ' + (pct(P.overall.impressions, D.overall.impressions) * 100).toFixed(0) + '%');
    if (pct(P.overall.results, D.overall.results) > 0.05) w.push('Resultados diferem ' + (pct(P.overall.results, D.overall.results) * 100).toFixed(0) + '%');
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
        const P = window.__parser.discoverV2(headers, rows);
        if (!P.breakdowns.platform) { setMsg('⚠ Este arquivo não tem a coluna Plataforma com dados — nada a fazer.', true); return; }
        const warns = validatePlatform(P);
        if (warns.length) { if (!window.confirm('Atenção — o Relatório 2 (plataforma) difere do principal:\n\n• ' + warns.join('\n• ') + '\n\nUsar mesmo assim, só para os gráficos de plataforma?')) { setMsg('Relatório 2 cancelado.', true); return; } }
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

  window.__afterRemap = () => {
    const c = window.__parser.getCache && window.__parser.getCache();
    if (!c) return;
    const snap = CONFIG ? serializeConfig(CONFIG) : null; // preserva as edições atuais
    DISCOVERED = window.__parser.discoverV2(c.headers, c.rows);
    CONFIG = snap ? applyConfigSnapshot(snap, DISCOVERED) : buildConfig(DISCOVERED);
    render();
    const st = document.getElementById('rt-status'); if (st) st.textContent = 'Colunas remapeadas e reprocessado.';
  };

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

  // ── casamento de imagens por nome ─────────────────────────────────
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]/g, '');
  function matchImages(files, status) {
    const slots = [...document.querySelectorAll('#deck image-slot[data-ad]')].filter((s) => s.getAttribute('data-ad'));
    const list = [...files].map((f) => ({ f, key: normName(f.name) }));
    let matched = 0;
    slots.forEach((slot) => {
      const adKey = normName(slot.getAttribute('data-ad'));
      if (!adKey) return;
      let best = null, score = 0;
      list.forEach((fl) => { let s = 0; if (fl.key && fl.key === adKey) s = 9999; else if (fl.key && (adKey.indexOf(fl.key) >= 0 || fl.key.indexOf(adKey) >= 0)) s = Math.min(fl.key.length, adKey.length); if (s > score) { score = s; best = fl; } });
      if (best && score > 0 && window.__feedSlot && window.__feedSlot(slot, best.f)) matched++;
    });
    if (status) status.textContent = 'Imagens casadas: ' + matched + ' de ' + slots.length + ' slots.';
  }

  // ── painel Configurações (incluir/ocultar/reordenar/mesclar/Top5/alcance) ──
  const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; };
  function candidatesForCampaign(cc) { return (cc.ref.adsAll && cc.ref.adsAll.length) ? cc.ref.adsAll : cc.ref.top5; }
  function candidatesForConj(cj) {
    const m = new Map();
    cj.refs.forEach((a) => (a.adsList || []).forEach(([n, r, sp]) => { const g = m.get(n) || { res: 0, spend: 0 }; g.res += r; g.spend += (sp || 0); m.set(n, g); }));
    const arr = [...m.entries()].sort(cmpAdEntry).map(([n, v]) => ({ name: n, results: Math.round(v.res) }));
    return arr.length ? arr : mergeAdsetsV2(cj.refs).top5;
  }

  function openSections() {
    if (!CONFIG) { const s = document.getElementById('rt-status'); if (s) s.textContent = 'Suba um relatório primeiro.'; return; }
    let host = document.getElementById('cfg-backdrop'); if (host) host.remove();
    host = document.createElement('div'); host.id = 'cfg-backdrop'; host.className = 'export-hidden';
    host.innerHTML = '<div class="cfg-card" id="sec-card"></div>';
    document.body.appendChild(host);
    host.addEventListener('click', (e) => { if (e.target === host) host.remove(); });
    const card = host.querySelector('#sec-card');

    function paint() {
      let h = '<h3>Configurações</h3>';
      // Nome dos conjuntos: resumido (padrão) x inteiro
      h += '<div class="sec-row" style="border-bottom:1px solid rgba(255,255,255,.12);padding-bottom:10px;margin-bottom:6px"><b>Nomes dos conjuntos:</b>' +
        '<button class="sec-mini' + (!CONFIG.fullConjNames ? ' on' : '') + '" data-act="cjname" data-mode="short">Resumido</button>' +
        '<button class="sec-mini' + (CONFIG.fullConjNames ? ' on' : '') + '" data-act="cjname" data-mode="full">Nome inteiro</button>' +
        '<small style="color:var(--ink-soft)">inteiro usa o nome completo do conjunto (a fonte diminui p/ caber)</small></div>';
      const KINDS = [['resultados', 'Resultados'], ['custo_resultado', 'Custo por resultado'], ['valor', 'Valor gasto']];
      h += '<div class="sec-block"><b>Ocultar dados em todo o relatório</b><div class="kind-grid">' + KINDS.map((k) => {
        const on = (CONFIG.hiddenKinds || []).indexOf(k[0]) >= 0;
        return '<label><input type="checkbox" data-act="kind" data-kind="' + k[0] + '"' + (on ? ' checked' : '') + '> ' + k[1] + '</label>';
      }).join('') + '</div></div>';
      h += '<div class="sec-block"><b>Seções</b><p style="margin:4px 0 8px;font-size:12px;color:var(--ink-soft)">Reordene (▲▼), renomeie, oculte e marque conjuntos (☑) para mesclar.</p></div>';
      CONFIG.campaigns.forEach((cc, ci) => {
        h += '<div class="sec-camp"><div class="sec-row">' +
          '<button class="sec-mini" data-act="cup" data-ci="' + ci + '">▲</button>' +
          '<button class="sec-mini" data-act="cdn" data-ci="' + ci + '">▼</button>' +
          '<input class="sec-lbl" data-act="clbl" data-ci="' + ci + '" value="' + esc(cc.label) + '">' +
          '<label><input type="checkbox" data-act="cinc" data-ci="' + ci + '" ' + (cc.include ? 'checked' : '') + '> incluir</label></div>';
        cc.conjuntos.forEach((cj, si) => {
          h += '<div class="sec-row sec-conj">' +
            '<input type="checkbox" class="msel" data-ci="' + ci + '" data-si="' + si + '" title="marcar para mesclar">' +
            '<button class="sec-mini" data-act="jup" data-ci="' + ci + '" data-si="' + si + '">▲</button>' +
            '<button class="sec-mini" data-act="jdn" data-ci="' + ci + '" data-si="' + si + '">▼</button>' +
            '<input class="sec-lbl" data-act="jlbl" data-ci="' + ci + '" data-si="' + si + '" value="' + esc(cj.label) + '">' +
            '<label><input type="checkbox" data-act="jinc" data-ci="' + ci + '" data-si="' + si + '" ' + (cj.include ? 'checked' : '') + '> incluir</label>' +
            '<button class="sec-mini" data-act="t5j" data-ci="' + ci + '" data-si="' + si + '">Top 5' + (cj.top5Override ? ' ✎' : '') + '</button>' +
            (cj.refs.length > 1 ? '<button class="sec-mini" data-act="jsplit" data-ci="' + ci + '" data-si="' + si + '">desmesclar</button>' : '') + '</div>';
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
      else if (act === 'jsplit') { const cj = cjs[si]; const extra = cj.refs.slice(1).map((r) => ({ refs: [r], label: conjLabel([r]), labelAuto: true, include: true })); cj.refs = [cj.refs[0]]; cj.label = conjLabel([cj.refs[0]]); cj.labelAuto = true; cjs.splice(si + 1, 0, ...extra); }
      else if (act === 'cjname') { CONFIG.fullConjNames = (b.dataset.mode === 'full'); CONFIG.campaigns.forEach((c) => c.conjuntos.forEach((cj) => { if (cj.labelAuto !== false) cj.label = conjLabel(cj.refs); })); render(); paint(); return; }
      else if (act === 'merge') {
        const idxs = [...card.querySelectorAll('.msel:checked')].filter((x) => +x.dataset.ci === ci).map((x) => +x.dataset.si).sort((a, b) => a - b);
        if (idxs.length < 2) return;
        const refs = [].concat(...idxs.map((k) => cjs[k].refs));
        const label = 'CONJUNTO ' + idxs.map((k) => cjs[k].label.replace(/^CONJUNTO\s*/i, '')).join(' + ');
        for (let k = idxs.length - 1; k >= 1; k--) cjs.splice(idxs[k], 1);
        cjs[idxs[0]] = { refs, label, include: true };
      } else if (act === 't5j') { const cj = cjs[si]; openTop5(cj, candidatesForConj(cj), mergeAdsetsV2(cj.refs).top5, cj.label, () => paint()); return; }
      else if (act === 'cfgexport') { exportConfig(); return; }
      else if (act === 'cfgimport') { importConfigPrompt(); return; }
      else return;
      render(); paint();
    });
    card.addEventListener('change', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const act = b.dataset.act, ci = +b.dataset.ci, si = +b.dataset.si;
      if (act === 'cinc') CONFIG.campaigns[ci].include = b.checked;
      else if (act === 'jinc') CONFIG.campaigns[ci].conjuntos[si].include = b.checked;
      else if (act === 'kind') { const k = b.dataset.kind, arr = CONFIG.hiddenKinds, idx = arr.indexOf(k); if (b.checked && idx < 0) arr.push(k); else if (!b.checked && idx >= 0) arr.splice(idx, 1); }
      else return;
      render();
    });
    card.addEventListener('input', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      if (b.dataset.act === 'clbl') CONFIG.campaigns[+b.dataset.ci].label = b.value;
      else if (b.dataset.act === 'jlbl') { const cj = CONFIG.campaigns[+b.dataset.ci].conjuntos[+b.dataset.si]; cj.label = b.value; cj.labelAuto = false; }
    });
    card.addEventListener('blur', (e) => { const b = e.target.closest && e.target.closest('[data-act]'); if (b && ['clbl', 'jlbl'].indexOf(b.dataset.act) >= 0) render(); }, true);
    paint();
  }

  // ── editor de Top 5 ───────────────────────────────────────────────
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
      let h = '<h3>Top 5 — ' + esc(label) + '</h3><p>Marque até 5 anúncios e ordene com ▲▼. Cada anúncio marcado vira uma página.</p>';
      work.forEach((w, i) => { h += '<div class="sec-row"><input type="checkbox" data-i="' + i + '" ' + (w.sel ? 'checked' : '') + '><button class="sec-mini" data-up="' + i + '">▲</button><button class="sec-mini" data-dn="' + i + '">▼</button><span class="t5-name">' + esc(w.name) + '</span><span class="t5-res">' + w.results + '</span></div>'; });
      h += '<div class="cfg-actions"><button id="t5-apply" class="rt-btn">Aplicar</button><button id="t5-auto" class="rt-btn" style="background:#444;color:#fff">Automático</button><button id="t5-close" class="rt-btn" style="background:#444;color:#fff">Fechar</button></div>';
      card.innerHTML = h;
      card.querySelector('#t5-close').onclick = () => host.remove();
      card.querySelector('#t5-auto').onclick = () => { delete node.top5Override; delete node.exclAds; host.remove(); render(); if (after) after(); };
      card.querySelector('#t5-apply').onclick = () => { const chosen = work.filter((w) => w.sel).slice(0, 5).map((w) => ({ name: w.name, results: w.results })); if (chosen.length) node.top5Override = chosen; else delete node.top5Override; host.remove(); render(); if (after) after(); };
    }
    card.addEventListener('click', (e) => {
      const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-dn]');
      if (up) { const i = +up.dataset.up; if (i > 0) { const t = work[i]; work[i] = work[i - 1]; work[i - 1] = t; } paintT(); }
      else if (dn) { const i = +dn.dataset.dn; if (i < work.length - 1) { const t = work[i]; work[i] = work[i + 1]; work[i + 1] = t; } paintT(); }
    });
    card.addEventListener('change', (e) => { const cb = e.target.closest('input[data-i]'); if (cb) work[+cb.dataset.i].sel = cb.checked; });
    paintT();
  }

  // ── wire ──────────────────────────────────────────────────────────
  function wire() {
    const $ = (id) => document.getElementById(id);
    const status = $('rt-status');
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
    if ($('rt-photo')) $('rt-photo').addEventListener('change', (e) => { if (e.target.files[0]) setPhotoFromFile(e.target.files[0]); e.target.value = ''; });
    if ($('rt-images')) $('rt-images').addEventListener('change', (e) => { if (e.target.files.length) matchImages(e.target.files, status); e.target.value = ''; });
    if ($('zoom-in')) $('zoom-in').addEventListener('click', () => setZoom(ZOOM + 0.25));
    if ($('zoom-out')) $('zoom-out').addEventListener('click', () => setZoom(ZOOM - 0.25));
    if ($('zoom-reset')) $('zoom-reset').addEventListener('click', () => setZoom(1));
    enablePan();
    const vEl = $('rt-version'); if (vEl) vEl.textContent = 'Versão ' + APP_VERSION + ' · V2';
    if ($('pg-prev')) $('pg-prev').addEventListener('click', () => deckGo(CUR - 1));
    if ($('pg-next')) $('pg-next').addEventListener('click', () => deckGo(CUR + 1));
    hideDeckOverlay(); updatePager();
    if ($('rt-platform')) $('rt-platform').addEventListener('change', (e) => { if (e.target.files[0]) onPlatformFile(e.target.files[0], status); e.target.value = ''; });
    if ($('rt-fab')) $('rt-fab').addEventListener('click', () => document.getElementById('report-toolbar').classList.toggle('open'));
    const goHome = () => { location.href = 'index.html'; };
    if ($('rt-home')) $('rt-home').addEventListener('click', goHome);
    if ($('ss-home')) $('ss-home').addEventListener('click', goHome);
    const toggleDrawer = () => { const dr = document.getElementById('nav-drawer'); dr.classList.toggle('open'); if (dr.classList.contains('open')) setTimeout(materializeThumbs, 30); };
    if ($('nav-toggle')) $('nav-toggle').addEventListener('click', toggleDrawer);
    if ($('ss-pick')) $('ss-pick').addEventListener('click', () => $('rt-file').click());
    if ($('ss-testdata')) $('ss-testdata').addEventListener('click', () => loadTestData(status));
    if ($('ss-pick-plat')) $('ss-pick-plat').addEventListener('click', () => $('rt-platform').click());
    if ($('ss-go')) $('ss-go').addEventListener('click', () => { if (!__wizR2) return; const ss = document.getElementById('start-screen'); if (ss) ss.classList.add('hidden'); });
    // assistente de upload: navegação entre os 3 passos
    document.querySelectorAll('#start-screen [data-next]').forEach((b) => b.addEventListener('click', () => wizStep(wizCurrent() + 1)));
    document.querySelectorAll('#start-screen [data-prev]').forEach((b) => b.addEventListener('click', () => wizStep(wizCurrent() - 1)));
    document.querySelectorAll('#start-screen .ss-step-dot').forEach((d) => d.addEventListener('click', () => { const i = +d.dataset.go; if (i === 2 && !__wizR1) return; wizStep(i); }));
  }

  window.__render = {
    render, get config() { return CONFIG; }, get discovered() { return DISCOVERED; },
    loadFile: (file) => onFile(file, document.getElementById('rt-status') || { textContent: '' }),
    loadPlatformFile: (file) => onPlatformFile(file, document.getElementById('rt-status') || { textContent: '' }),
  };
  window.addEventListener('load', wire);
})();
