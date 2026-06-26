/**
 * Relatório V3 — fonte de dados via API da Meta (Graph API).
 *
 * Diferente da V1/V2 (que sobem Excel à mão), a V3 puxa os números direto da
 * conta de anúncios. Este arquivo NÃO reimplementa o relatório: ele apenas
 *   1. pede ao backend (api/v3-meta-insights.php) os dados do período escolhido;
 *   2. transforma a resposta em uma planilha (igual a um Excel exportado); e
 *   3. entrega essa planilha ao motor da V2 (window.__render.loadFile), que já
 *      sabe desenhar tudo. Assim a V2 fica 100% intacta.
 *
 * O backend mantém perfis e cache (contas, relatórios, criativos e foto) para
 * reduzir as chamadas à Meta. Esta tela mostra a origem dos dados (ao vivo ou
 * cache) e o consumo da API, e permite forçar a atualização.
 *
 * Segurança: o token da Meta vive só no servidor; aqui só falamos com o nosso
 * próprio backend (mesma origem), que exige login do sistema.
 */
(function () {
  'use strict';

  var API = 'api/v3-meta-insights.php';
  // Carimbo de versão do FRONTEND. BATA com o V3_BUILD do backend
  // (api/v3-meta-insights.php) a cada release: a tela mostra os dois e avisa se
  // divergirem — é assim que se confirma que o deploy (JS + PHP) realmente subiu.
  var V3_BUILD = 'v3.12 · 2026-06-24';
  var csrf = '';
  var accountsLoaded = false;
  var periodType = 'mensal';            // mensal · quinzenal · custom
  var pendingThumbs = null;             // mapa nome→url aplicado quando os slots ficam prontos
  var thumbsFallbackTimer = null;
  var lastGen = null;                   // { account, t, since, until, label } da última geração — usado pelo "recarregar imagens"

  var MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

  /* ── utilidades ───────────────────────────────────────────────────────── */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return ymd(new Date()); }
  function lastDay(y, m) { return new Date(y, m, 0).getDate(); }     // m = 1..12
  function capToday(s) { return s > todayStr() ? todayStr() : s; }
  // Não logado → tela de login do sistema, pedindo para VOLTAR pra esta página
  // da V3 (?next=) depois de autenticar, em vez de cair no Banco de Imagens.
  function goToLogin() {
    var next = location.pathname + location.search + location.hash;
    window.location.href = '/?next=' + encodeURIComponent(next);
  }
  function downloadJson(obj, name) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ── período (tipo → opções, sem datas inexistentes/futuras) ───────────── */
  function recentMonths(n) {
    var out = [], d = new Date(); d.setDate(1);
    for (var i = 0; i < n; i++) {
      out.push({ ym: d.getFullYear() + '-' + pad2(d.getMonth() + 1), y: d.getFullYear(), m: d.getMonth() + 1 });
      d.setMonth(d.getMonth() - 1);
    }
    return out;
  }
  function monthRange(ym) {
    var p = ym.split('-'), y = +p[0], m = +p[1];
    return { since: ym + '-01', until: capToday(ym + '-' + pad2(lastDay(y, m))) };
  }
  function fortnightRange(ym, half) {
    var p = ym.split('-'), y = +p[0], m = +p[1];
    if (half === '1') return { since: ym + '-01', until: capToday(ym + '-15') };
    return { since: ym + '-16', until: capToday(ym + '-' + pad2(lastDay(y, m))) };
  }
  /* Monta os campos de período conforme o tipo escolhido. */
  function renderPeriodOptions() {
    var host = document.getElementById('v3-popts');
    if (!host) return;
    var months = recentMonths(15);
    if (periodType === 'mensal') {
      var opts = months.map(function (mo, i) {
        return '<option value="' + mo.ym + '"' + (i === 1 ? ' selected' : '') + '>' + MESES[mo.m - 1] + ' ' + mo.y + (i === 0 ? ' (mês atual — parcial)' : '') + '</option>';
      }).join('');
      host.innerHTML = '<label for="v3-month">Mês</label><select id="v3-month">' + opts + '</select>';
    } else if (periodType === 'quinzenal') {
      var fo = [];
      months.forEach(function (mo) {
        var ml = MESES[mo.m - 1] + ' ' + mo.y;
        if (mo.ym + '-16' <= todayStr()) fo.push('<option value="' + mo.ym + '|2">2ª quinzena · ' + ml + '</option>');
        if (mo.ym + '-01' <= todayStr()) fo.push('<option value="' + mo.ym + '|1">1ª quinzena · ' + ml + '</option>');
      });
      host.innerHTML = '<label for="v3-fortnight">Quinzena</label><select id="v3-fortnight">' + fo.join('') + '</select>';
    } else {
      var lm = monthRange(months[1].ym);   // mês anterior como padrão
      host.innerHTML =
        '<div class="v3-row">' +
        '  <div><label for="v3-since">De</label><input type="date" id="v3-since" max="' + todayStr() + '" value="' + lm.since + '"></div>' +
        '  <div><label for="v3-until">Até</label><input type="date" id="v3-until" max="' + todayStr() + '" value="' + lm.until + '"></div>' +
        '</div>';
    }
  }
  /* Período atual (since/until) a partir do tipo + opção selecionada. */
  function currentPeriod() {
    if (periodType === 'mensal') {
      var ms = document.getElementById('v3-month');
      return ms ? monthRange(ms.value) : null;
    }
    if (periodType === 'quinzenal') {
      var fs = document.getElementById('v3-fortnight');
      if (!fs || !fs.value) return null;
      var v = fs.value.split('|');
      return fortnightRange(v[0], v[1]);
    }
    var s = document.getElementById('v3-since'), u = document.getElementById('v3-until');
    return (s && u) ? { since: s.value, until: u.value } : null;
  }
  function dayCount(s, u) { return Math.round((new Date(u) - new Date(s)) / 86400000) + 1; }
  /* nome do período pra capa/cabeçalho (auto; editável depois pelo usuário) */
  function periodWord(s, u) {
    var d = dayCount(s, u);
    if (d <= 1) return 'Diário';
    if (d >= 6 && d <= 8) return 'Semanal';
    if (d >= 13 && d <= 16) return 'Quinzenal';
    if (d >= 28 && d <= 31) return 'Mensal';
    return 'Período';
  }

  /* Converte um "array de arrays" (linha 0 = cabeçalhos) num arquivo .xlsx em
     memória, para reaproveitar exatamente o mesmo caminho do upload de Excel. */
  function aoaToFile(aoa, name) {
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    var buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    return new File([buf], name, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      lastModified: Date.now(),
    });
  }

  /* Guarda o último request/resposta para o "baixar diagnóstico" — assim, mesmo
     quando nada na tela carrega, dá pra exportar o que aconteceu pro suporte. */
  var lastDiag = null;

  /* Monta uma linha de erro legível com tudo que ajuda a depurar: a mensagem em
     PT + código, tipo, origem (arquivo:linha) e status HTTP quando houver. */
  function errLine(d) {
    if (!d) return 'erro desconhecido';
    var t = d.error || 'erro não informado';
    var extra = [];
    if (d.code) extra.push(d.code);
    if (d.error_tipo) extra.push(d.error_tipo);
    if (d.error_origem) extra.push('em ' + d.error_origem);
    if (d.step) extra.push('etapa: ' + d.step);
    if (typeof d.ms === 'number') extra.push(d.ms + 'ms');
    if (typeof d._http === 'number' && d._http) extra.push('HTTP ' + d._http);
    if (extra.length) t += ' <span style="opacity:.7">[' + esc(extra.join(' · ')) + ']</span>';
    return t;
  }

  /* Loga o erro completo no console (nome, tipo, código, HTTP, corpo cru) para
     dar um "breakpoint" de diagnóstico em qualquer falha. */
  function logDiag(label, d) {
    try {
      console.groupCollapsed('%c[V3] ' + label, 'color:#ff6b6b;font-weight:700');
      console.error('mensagem :', d && d.error);
      console.error('code     :', d && d.code);
      console.error('tipo     :', d && d.error_tipo);
      console.error('origem   :', d && d.error_origem);
      console.error('HTTP     :', d && d._http);
      if (d && d.error_detalhe) console.error('detalhe  :', d.error_detalhe);
      if (d && d._raw) console.error('corpo cru:', d._raw);
      console.groupEnd();
    } catch (e) {}
  }

  async function callApi(opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-CSRF-Token'] = csrf;
      init.body = JSON.stringify(opts.body);
    }
    var url = API + (opts.query || '');
    var res, raw = '', data;

    // Falha de transporte (offline, DNS, conexão recusada): nunca houve resposta.
    try {
      res = await fetch(url, init);
    } catch (netErr) {
      data = {
        ok: false, code: 'NETWORK', _http: 0,
        error: 'Falha de conexão com o servidor (a requisição não chegou a responder).',
        error_tipo: (netErr && netErr.name) || 'NetworkError',
        error_detalhe: (netErr && netErr.message) || String(netErr),
      };
      lastDiag = { quando: new Date().toISOString(), metodo: init.method, url: url, body: opts.body || null, http: 0, raw: '', parsed: data };
      logDiag('callApi NETWORK', data);
      return data;
    }

    try { raw = await res.text(); } catch (e) { raw = ''; }
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      // O servidor respondeu, mas não com JSON (502/500 do gateway, crash do PHP,
      // página de erro HTML). Mostra o status e um trecho do corpo pra diagnosticar.
      data = {
        ok: false, code: 'BAD_JSON',
        error: 'Resposta inválida do servidor (HTTP ' + res.status + (res.statusText ? ' ' + res.statusText : '') + ').',
        error_tipo: 'NonJSON',
        error_detalhe: (raw || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400),
      };
    }
    data._http = res.status;
    data._raw = (raw || '').slice(0, 2000);
    lastDiag = { quando: new Date().toISOString(), metodo: init.method, url: url, body: opts.body || null, http: res.status, raw: (raw || '').slice(0, 4000), parsed: data };
    if (!data.ok) logDiag('callApi ' + (data.code || 'ERRO'), data);
    return data;
  }

  /* ── overlay (tela de seleção) ────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('v3-style')) return;
    var css = ''
      + '#v3-screen{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;'
      + 'background:radial-gradient(1200px 800px at 70% -10%,#13344a,#0a1b26 60%);font-family:"Open Sans",system-ui,sans-serif;color:#eaf4f6}'
      + '#v3-screen .v3-card{width:min(560px,92vw);max-height:94vh;overflow:auto;background:#0e2330;border:1px solid rgba(50,205,205,.25);border-radius:18px;'
      + 'padding:30px 32px;box-shadow:0 24px 60px rgba(0,0,0,.45)}'
      + '#v3-screen .v3-brand{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#32cdcd;font-weight:700;margin-bottom:6px}'
      + '#v3-screen h1{font-size:24px;font-weight:800;margin:0 0 4px}'
      + '#v3-screen p.v3-sub{margin:0 0 22px;font-size:14px;line-height:1.5;color:#9fc1c9}'
      + '#v3-screen label{display:block;font-size:12px;font-weight:600;color:#9fc1c9;margin:0 0 6px;letter-spacing:.02em}'
      + '#v3-screen select,#v3-screen input[type=date]{width:100%;box-sizing:border-box;background:#08171f;color:#eaf4f6;'
      + 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:12px 14px;font-size:15px;margin-bottom:18px}'
      + '#v3-screen input[type=date]{color-scheme:dark}'
      + '#v3-screen .v3-acc-row{display:flex;gap:8px;align-items:stretch;margin-bottom:18px}'
      + '#v3-screen .v3-acc-row select{flex:1;margin:0}'
      + '#v3-screen .v3-icon-btn{flex:none;background:#08171f;color:#9fc1c9;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:0 14px;cursor:pointer;font-size:16px}'
      + '#v3-screen .v3-icon-btn:hover{color:#32cdcd;border-color:rgba(50,205,205,.5)}'
      + '#v3-screen .v3-presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}'
      + '#v3-screen .v3-presets button{flex:1;min-width:90px;background:#08171f;color:#9fc1c9;border:1px solid rgba(255,255,255,.16);'
      + 'border-radius:8px;padding:9px 6px;font:600 13px "Open Sans",sans-serif;cursor:pointer}'
      + '#v3-screen .v3-presets button.on{background:#32cdcd;color:#06222a;border-color:#32cdcd}'
      + '#v3-screen .v3-row{display:flex;gap:14px}#v3-screen .v3-row>div{flex:1}'
      + '#v3-screen .v3-btn{width:100%;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;'
      + 'background:#32cdcd;color:#06222a;transition:filter .15s}#v3-screen .v3-btn:hover{filter:brightness(1.07)}'
      + '#v3-screen .v3-btn:disabled{opacity:.5;cursor:not-allowed}'
      + '#v3-screen .v3-btn.alt{background:transparent;color:#32cdcd;border:1px solid rgba(50,205,205,.4);margin-top:10px}'
      + '#v3-screen .v3-msg{min-height:20px;margin-top:16px;font-size:13.5px;line-height:1.5;color:#9fc1c9}'
      + '#v3-screen .v3-msg.err{color:#ff9a9a}#v3-screen .v3-msg.ok{color:#7fe3c0}'
      + '#v3-screen .v3-msg a{color:#32cdcd}'
      + '#v3-screen .v3-prog{margin-top:14px}'
      + '#v3-screen .v3-prog-bar{height:8px;background:#08171f;border:1px solid rgba(255,255,255,.12);border-radius:99px;overflow:hidden}'
      + '#v3-screen .v3-prog-bar i{display:block;height:100%;width:0;background:linear-gradient(90deg,#1ba7a7,#32cdcd);transition:width .35s ease}'
      + '#v3-screen .v3-prog-lbl{margin-top:7px;font-size:12.5px;color:#9fc1c9;text-align:center}'
      + '#v3-screen .v3-usage{margin-top:10px;font-size:12px;color:#6f8a93}#v3-screen .v3-usage b{color:#9fc1c9}'
      + '#v3-screen .v3-usage .warn{color:#ffb454;font-weight:600}'
      + '#v3-screen .v3-dbg{display:block;text-align:center;margin-top:14px;font-size:12px;color:#6f8a93;text-decoration:underline;cursor:pointer}'
      + '#v3-screen .v3-build{text-align:center;margin-top:8px;font-size:11px;line-height:1.4;color:#5a737b}'
      + '#v3-screen .v3-build b{color:#7f9aa3;font-weight:600}'
      + '#v3-screen .v3-build .warn{color:#ffb454;font-weight:600}'
      + '#v3-reopen{position:fixed;left:14px;bottom:14px;z-index:8000;background:#0e2330;color:#32cdcd;border:1px solid rgba(50,205,205,.4);'
      + 'border-radius:999px;padding:9px 16px;font:600 13px/1 "Open Sans",sans-serif;cursor:pointer;display:none}'
      + '#v3-screen .v3-spin,#v3-pm .v3-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#32cdcd;'
      + 'border-radius:50%;animation:v3spin .8s linear infinite;vertical-align:-2px;margin-right:7px}'
      + '@keyframes v3spin{to{transform:rotate(360deg)}}'
      // selo de origem (persistente, ao lado do botão de trocar cliente)
      + '#v3-origin{position:fixed;left:14px;bottom:54px;z-index:8000;font:600 12px/1 "Open Sans",sans-serif;padding:7px 12px;border-radius:999px}'
      + '#v3-origin.live{background:#0f3a2e;color:#7fe3c0;border:1px solid rgba(127,227,192,.4)}'
      + '#v3-origin.cache{background:#2a2410;color:#ffd28a;border:1px solid rgba(255,180,84,.4)}'
      // modal do gerenciador de perfis
      + '#v3-pm{position:fixed;inset:0;z-index:9500;display:none;align-items:flex-start;justify-content:center;background:rgba(4,12,18,.7);font-family:"Open Sans",system-ui,sans-serif;padding:30px 16px;overflow:auto}'
      + '#v3-pm .v3-pm-card{width:min(760px,96vw);background:#0e2330;border:1px solid rgba(50,205,205,.25);border-radius:16px;color:#eaf4f6;box-shadow:0 24px 60px rgba(0,0,0,.5)}'
      + '#v3-pm .v3-pm-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.08)}'
      + '#v3-pm .v3-pm-head h2{margin:0;font-size:18px;font-weight:800}'
      + '#v3-pm #v3-pm-close{background:transparent;border:0;color:#9fc1c9;font-size:18px;cursor:pointer}'
      + '#v3-pm #v3-pm-body{padding:18px 22px}'
      + '#v3-pm .v3-pm-load,#v3-pm .v3-pm-empty,#v3-pm .v3-pm-err{color:#9fc1c9;font-size:14px}#v3-pm .v3-pm-err{color:#ff9a9a}'
      + '#v3-pm .v3-pm-usage{font-size:12px;color:#6f8a93;margin-bottom:14px}#v3-pm .v3-pm-usage b{color:#9fc1c9}'
      + '#v3-pm .v3-pm-item{display:flex;gap:16px;padding:16px 0;border-top:1px solid rgba(255,255,255,.07)}#v3-pm .v3-pm-item:first-of-type{border-top:0}'
      + '#v3-pm .v3-pm-photo{width:64px;height:64px;border-radius:50%;object-fit:cover;flex:none;background:#08171f}'
      + '#v3-pm .v3-pm-photo.empty{display:flex;align-items:center;justify-content:center;text-align:center;font-size:10px;color:#6f8a93;line-height:1.2}'
      + '#v3-pm .v3-pm-info{flex:1;min-width:0}'
      + '#v3-pm .v3-pm-name{font-size:15px;font-weight:700}#v3-pm .v3-pm-bm{color:#6f8a93;font-weight:400;font-size:13px}'
      + '#v3-pm .v3-pm-meta{font-size:12.5px;color:#9fc1c9;margin:3px 0 8px}'
      + '#v3-pm .v3-pm-periods{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}'
      + '#v3-pm .v3-pm-period{font-size:11px;background:#08171f;border:1px solid rgba(127,227,192,.3);color:#7fe3c0;border-radius:6px;padding:3px 8px}'
      + '#v3-pm .v3-pm-period.open{border-color:rgba(255,180,84,.4);color:#ffd28a}'
      + '#v3-pm .v3-pm-none{font-size:12px;color:#6f8a93}'
      + '#v3-pm .v3-pm-actions{display:flex;gap:8px;flex-wrap:wrap}'
      + '#v3-pm .v3-pm-actions button{background:#08171f;color:#9fc1c9;border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:7px 12px;font:600 12px "Open Sans",sans-serif;cursor:pointer}'
      + '#v3-pm .v3-pm-actions button:hover{color:#32cdcd;border-color:rgba(50,205,205,.5)}'
      + '#v3-pm .v3-pm-gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;margin-top:12px}'
      + '#v3-pm .v3-pm-gallery figure{margin:0}'
      + '#v3-pm .v3-pm-gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px;background:#08171f}'
      + '#v3-pm .v3-pm-gallery figcaption{font-size:10px;color:#6f8a93;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      // busca + editor de perfil (nome/máscara + foto)
      + '#v3-pm .v3-pm-search{width:100%;box-sizing:border-box;background:#08171f;color:#eaf4f6;border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:11px 14px;font-size:14px;margin-bottom:16px}'
      + '#v3-pm .v3-pm-search:focus{outline:none;border-color:rgba(50,205,205,.55)}'
      + '#v3-pm .v3-pm-search::placeholder{color:#6f8a93}'
      + '#v3-pm .v3-pm-empty-search{color:#6f8a93;font-size:13px;padding:10px 0}'
      + '#v3-pm .v3-pm-edit{margin-top:12px;padding:14px;background:#08171f;border:1px solid rgba(255,255,255,.1);border-radius:10px}'
      + '#v3-pm .v3-pm-edit label{display:block;font-size:12px;font-weight:600;color:#9fc1c9;margin:0 0 6px}'
      + '#v3-pm .v3-pm-edit .v3-pm-namerow{display:flex;gap:8px;align-items:stretch}'
      + '#v3-pm .v3-pm-edit input[type=text]{flex:1;min-width:0;box-sizing:border-box;background:#0e2330;color:#eaf4f6;border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:9px 12px;font-size:14px}'
      + '#v3-pm .v3-pm-edit input[type=text]:focus{outline:none;border-color:rgba(50,205,205,.55)}'
      + '#v3-pm .v3-pm-edit .v3-pm-save{flex:none;background:#32cdcd;color:#06222a;border:0;border-radius:8px;padding:0 16px;font:700 13px "Open Sans",sans-serif;cursor:pointer}'
      + '#v3-pm .v3-pm-edit .v3-pm-save:hover{filter:brightness(1.07)}'
      + '#v3-pm .v3-pm-edit .v3-pm-hint{font-size:11.5px;color:#6f8a93;margin-top:6px;line-height:1.4}'
      + '#v3-pm .v3-pm-edit .v3-pm-photo-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}'
      + '#v3-pm .v3-pm-edit .v3-pm-photo-row .v3-pm-fbtn{background:#0e2330;color:#9fc1c9;border:1px solid rgba(255,255,255,.16);border-radius:8px;padding:8px 12px;font:600 12px "Open Sans",sans-serif;cursor:pointer}'
      + '#v3-pm .v3-pm-edit .v3-pm-photo-row .v3-pm-fbtn:hover{color:#32cdcd;border-color:rgba(50,205,205,.5)}'
      + '#v3-pm .v3-pm-edit .v3-pm-save-msg{font-size:12px;margin-top:8px;min-height:14px}'
      + '#v3-pm .v3-pm-edit .v3-pm-save-msg.ok{color:#7fe3c0}#v3-pm .v3-pm-edit .v3-pm-save-msg.err{color:#ff9a9a}'
      // modal de anomalias (só o usuário vê; nunca entra no PDF)
      + '#v3-anom{position:fixed;inset:0;z-index:9600;display:none;align-items:center;justify-content:center;background:rgba(4,12,18,.72);font-family:"Open Sans",system-ui,sans-serif;padding:24px}'
      + '#v3-anom .v3-anom-card{width:min(560px,94vw);max-height:88vh;overflow:auto;background:#0e2330;border:1px solid rgba(255,180,84,.35);border-radius:16px;color:#eaf4f6;box-shadow:0 24px 60px rgba(0,0,0,.5);padding:26px 28px}'
      + '#v3-anom .v3-anom-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap}'
      + '#v3-anom h2{margin:0;font-size:20px;font-weight:800;color:#ffd28a}'
      + '#v3-anom .v3-anom-only{font-size:11px;color:#6f8a93}'
      + '#v3-anom .v3-anom-sub{margin:8px 0 18px;font-size:13.5px;line-height:1.5;color:#9fc1c9}'
      + '#v3-anom .v3-anom-list{display:flex;flex-direction:column;gap:10px;margin-bottom:20px}'
      + '#v3-anom .v3-anom-item{display:flex;align-items:center;justify-content:space-between;gap:14px;background:#08171f;border:1px solid rgba(255,255,255,.1);border-left:4px solid #9fc1c9;border-radius:10px;padding:12px 16px}'
      + '#v3-anom .v3-anom-item.up{border-left-color:#7fe3c0}#v3-anom .v3-anom-item.down{border-left-color:#ff9a9a}#v3-anom .v3-anom-item.shift{border-left-color:#ffb454}'
      + '#v3-anom .v3-anom-txt{font-size:14px;font-weight:600}'
      + '#v3-anom .v3-anom-vs{font-size:12.5px;color:#9fc1c9;white-space:nowrap;text-align:right}#v3-anom .v3-anom-vs i{color:#6f8a93;font-style:normal}'
      + '#v3-anom .v3-anom-ok{width:100%;border:0;border-radius:10px;padding:13px;font:700 15px "Open Sans",sans-serif;cursor:pointer;background:#32cdcd;color:#06222a}'
      + '#v3-anom .v3-anom-ok:hover{filter:brightness(1.07)}'
      + '#v3-anom .v3-anom-clean{margin:6px 0 20px;font-size:14px;line-height:1.5;color:#7fe3c0;background:#08171f;border:1px solid rgba(127,227,192,.25);border-left:4px solid #7fe3c0;border-radius:10px;padding:14px 16px}'
      + '@media print{#v3-anom{display:none!important}}'
      // aviso flutuante (toast) do estado da análise de anomalias — some sozinho, nunca no PDF
      + '#v3-toast{position:fixed;left:50%;bottom:84px;transform:translateX(-50%) translateY(10px);z-index:9500;'
      + '  display:none;align-items:center;gap:10px;max-width:min(460px,92vw);'
      + '  background:#0e2330;border:1px solid rgba(50,205,205,.35);border-radius:999px;color:#eaf4f6;'
      + '  font:600 13px "Open Sans",system-ui,sans-serif;padding:11px 18px;box-shadow:0 14px 38px rgba(0,0,0,.5);'
      + '  opacity:0;transition:opacity .25s ease,transform .25s ease}'
      + '#v3-toast.show{display:flex;opacity:1;transform:translateX(-50%) translateY(0)}'
      + '#v3-toast.clickable{cursor:pointer}#v3-toast.clickable:hover{border-color:rgba(50,205,205,.7)}'
      + '#v3-toast.warn{border-color:rgba(255,180,84,.5)}'
      + '#v3-toast .v3-toast-dot{width:14px;height:14px;border-radius:50%;flex:0 0 auto;'
      + '  border:2px solid rgba(50,205,205,.3);border-top-color:#32cdcd;animation:v3spin .7s linear infinite}'
      + '@keyframes v3spin{to{transform:rotate(360deg)}}'
      + '@media print{#v3-toast{display:none!important}}';
    var s = document.createElement('style'); s.id = 'v3-style'; s.textContent = css;
    document.head.appendChild(s);
  }

  function buildOverlay() {
    injectStyles();
    var wrap = document.createElement('div');
    wrap.id = 'v3-screen';
    wrap.innerHTML = ''
      + '<div class="v3-card">'
      + '  <div class="v3-brand">Relatórios de Resultados · V3</div>'
      + '  <h1>Puxar direto da Meta</h1>'
      + '  <p class="v3-sub">Escolha o perfil do cliente e o período. Os números vêm da conta de anúncios — e ficam salvos para não repetir consultas.</p>'
      + '  <div id="v3-form">'
      + '    <label for="v3-acc">Perfil do cliente (conta de anúncios)</label>'
      + '    <div class="v3-acc-row">'
      + '      <select id="v3-acc"><option>Carregando…</option></select>'
      + '      <button type="button" class="v3-icon-btn" id="v3-acc-refresh" title="Atualizar a lista de perfis na Meta">↻</button>'
      + '    </div>'
      + '    <label>Tipo de período</label>'
      + '    <div id="v3-ptype" class="v3-presets">'
      + '      <button type="button" data-ptype="mensal">Mensal</button>'
      + '      <button type="button" data-ptype="quinzenal">Quinzenal</button>'
      + '      <button type="button" data-ptype="custom">Personalizado</button>'
      + '    </div>'
      + '    <div id="v3-popts"></div>'
      + '    <button class="v3-btn" id="v3-go" disabled>Gerar relatório</button>'
      + '    <button class="v3-btn alt" id="v3-pm-open" type="button">👥 Gerenciar perfis</button>'
      + '  </div>'
      + '  <div class="v3-msg" id="v3-msg"></div>'
      + '  <div class="v3-prog" id="v3-prog" style="display:none"><div class="v3-prog-bar"><i id="v3-prog-fill"></i></div><div class="v3-prog-lbl" id="v3-prog-lbl"></div></div>'
      + '  <div class="v3-usage" id="v3-usage"></div>'
      + '  <a href="#" id="v3-dbg" class="v3-dbg">baixar diagnóstico (debug)</a>'
      + '  <div id="v3-build" class="v3-build"></div>'
      + '  <div id="v3-login" style="display:none">'
      + '    <button class="v3-btn" id="v3-login-open">Fazer login</button>'
      + '    <button class="v3-btn alt" id="v3-login-retry">Já entrei — tentar de novo</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(wrap);

    var badge = document.createElement('div');
    badge.id = 'v3-origin';
    badge.style.display = 'none';
    document.body.appendChild(badge);

    var reopen = document.createElement('button');
    reopen.id = 'v3-reopen';
    reopen.textContent = '↻ Trocar cliente/período';
    reopen.addEventListener('click', showOverlay);
    document.body.appendChild(reopen);

    setPeriodType('mensal');
    document.querySelectorAll('#v3-ptype button').forEach(function (b) { b.addEventListener('click', function () { setPeriodType(b.getAttribute('data-ptype')); }); });
    document.getElementById('v3-go').addEventListener('click', function () { generate(false); });
    document.getElementById('v3-acc-refresh').addEventListener('click', function () { loadAccounts(true); });
    document.getElementById('v3-pm-open').addEventListener('click', openProfileModal);
    document.getElementById('v3-dbg').addEventListener('click', function (e) { e.preventDefault(); downloadDebug(); });
    document.getElementById('v3-login-open').addEventListener('click', goToLogin);
    document.getElementById('v3-login-retry').addEventListener('click', function () { loadAccounts(false); });
    setBuildInfo();   // mostra de cara o build do frontend (servidor entra ao listar)
  }

  function setPeriodType(t) {
    periodType = t;
    document.querySelectorAll('#v3-ptype button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-ptype') === t); });
    renderPeriodOptions();
  }

  function showOverlay() { document.getElementById('v3-screen').style.display = 'flex'; document.getElementById('v3-reopen').style.display = 'none'; }
  function hideOverlay() { document.getElementById('v3-screen').style.display = 'none'; document.getElementById('v3-reopen').style.display = 'block'; }

  function msg(text, kind) {
    var m = document.getElementById('v3-msg');
    m.className = 'v3-msg' + (kind ? ' ' + kind : '');
    m.innerHTML = text;
  }
  function showLogin(on) {
    document.getElementById('v3-login').style.display = on ? 'block' : 'none';
    document.getElementById('v3-form').style.display = on ? 'none' : 'block';
  }

  /* Progresso da geração. A consulta à Meta é uma requisição única e opaca, então
     a barra avança por ESTIMATIVA durante essa etapa (assintótica — nunca passa do
     alvo); o que é real são as ETAPAS: consultar → montar → finalizar. */
  var progTimer = null, progPct = 0, progTarget = 0;
  function setProgress(p) { progPct = Math.max(progPct, Math.min(100, p)); var f = document.getElementById('v3-prog-fill'); if (f) f.style.width = progPct.toFixed(0) + '%'; }
  function setStage(lbl, target) { var l = document.getElementById('v3-prog-lbl'); if (l) l.textContent = lbl; if (typeof target === 'number') progTarget = target; }
  function startProgress(lbl) {
    var box = document.getElementById('v3-prog'); if (box) box.style.display = 'block';
    progPct = 0; progTarget = 80; setProgress(3); setStage(lbl, 80);
    if (progTimer) clearInterval(progTimer);
    progTimer = setInterval(function () { progPct += (progTarget - progPct) * 0.08; setProgress(progPct); }, 300);
  }
  function stopProgress() {
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    setProgress(100);
    setTimeout(function () { var box = document.getElementById('v3-prog'); if (box) box.style.display = 'none'; progPct = 0; setProgress(0); }, 400);
  }

  /* Medidor de consumo da API da Meta hoje (chamadas ao vivo + maior % de cota). */
  function renderUsage(usage) {
    var el = document.getElementById('v3-usage');
    if (!el) return;
    if (!usage) { el.innerHTML = ''; return; }
    var pct = usage.max_buc || 0;
    el.innerHTML = 'Consumo da API Meta hoje: <b>' + pct + '%</b> · ' + (usage.calls || 0) + ' chamada(s) ao vivo'
      + (pct >= 80 ? ' <span class="warn">— perto do limite, prefira o cache</span>' : '');
  }

  /* Mostra o build do frontend (esta tela) e, quando o backend responde, o build
     do servidor — avisando se divergirem. */
  function setBuildInfo(backendBuild) {
    var el = document.getElementById('v3-build');
    if (!el) return;
    var html = 'build · front <b>' + esc(V3_BUILD) + '</b>';
    if (typeof backendBuild !== 'undefined') {
      if (!backendBuild) {
        html += ' · servidor <span class="warn">sem versão (PHP antigo — suba o v3-meta-insights.php)</span>';
      } else {
        html += ' · servidor <b>' + esc(backendBuild) + '</b>';
        if (backendBuild !== V3_BUILD) html += ' <span class="warn">(versões diferentes — limpe o cache/suba os 2 arquivos)</span>';
      }
    }
    el.innerHTML = html;
  }

  /* Cliente selecionado no seletor (conta + BM + rótulo). */
  function currentClient() {
    var sel = document.getElementById('v3-acc');
    if (!sel || !sel.value) return null;
    var opt = sel.options[sel.selectedIndex];
    return { account: sel.value, t: Number(opt.getAttribute('data-t') || 0), label: opt.getAttribute('data-label') || '', mask: opt.getAttribute('data-mask') || '' };
  }

  /* ── fluxo ────────────────────────────────────────────────────────────── */
  async function loadAccounts(force) {
    showLogin(false);
    msg('<span class="v3-spin"></span>' + (force ? 'Atualizando a lista de perfis…' : 'Verificando login e perfis…'));
    // GET (não exige CSRF): a listagem é um read seguro e DEVOLVE o token CSRF
    // que os POSTs seguintes (gerar/foto) usam. O primeiro acesso ainda não tem token.
    var data = await callApi({ method: 'GET', query: force ? '?refresh=1' : '' });
    if (!data.ok) {
      if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) {
        goToLogin();   // não está logado → vai direto pra tela de login do sistema
        return;
      }
      var selErr = document.getElementById('v3-acc');
      if (selErr) selErr.innerHTML = '<option value="">(erro ao carregar)</option>';
      if (data.code === 'NOT_CONFIGURED') { msg('A API da Meta ainda não foi configurada no servidor. Veja <b>relatorio/DEPLOY-V3.md</b>.', 'err'); return; }
      msg('Falha ao carregar perfis: ' + errLine(data) + '<br><span style="opacity:.8">Use <b>baixar diagnóstico (debug)</b> abaixo e mande pro suporte.</span>', 'err');
      return;
    }
    csrf = data.csrf || '';
    accountsLoaded = true;
    setBuildInfo(data.build || null);   // confirma a versão do PHP que respondeu
    renderUsage(data.usage);
    var sel = document.getElementById('v3-acc');
    var accts = data.accounts || [];
    if (!accts.length) {
      sel.innerHTML = '<option value="">(nenhum perfil)</option>';
      msg('Nenhuma conta acessível pelo token. Confira a parceria/atribuição da conta ao Usuário do Sistema (ou preencha META_ACCOUNTS). Veja <b>relatorio/DEPLOY-V3.md</b>.', 'err');
      return;
    }
    var multi = !!data.multi;   // mais de uma BM → mostra de qual cada conta veio
    sel.innerHTML = accts.map(function (a) {
      var nome = (a.mask && a.mask.trim()) ? a.mask : a.label;   // máscara (nome de exibição) quando definida
      var lbl = (a.has_photo ? '📷 ' : '') + esc(nome) + (multi && a.bm ? ' · ' + esc(a.bm) : '');
      return '<option value="' + esc(a.act_id) + '" data-t="' + (a.t || 0) + '" data-label="' + esc(a.label) + '" data-mask="' + esc(a.mask || '') + '">' + lbl + '</option>';
    }).join('');
    document.getElementById('v3-go').disabled = false;
    var src = data.origin === 'cache' ? 'da lista salva' : (data.auto ? 'lista automática da Meta' : 'lista configurada');
    msg('Pronto (' + accts.length + ' perfil' + (accts.length > 1 ? 's' : '') + ', ' + src + '). Escolha o cliente e o período e clique em <b>Gerar relatório</b>.');
  }

  async function generate(force) {
    if (!accountsLoaded) { await loadAccounts(false); return; }
    var c = currentClient();
    if (!c) { msg('Selecione um cliente.', 'err'); return; }
    var per = currentPeriod();
    if (!per || !per.since || !per.until) { msg('Escolha o período.', 'err'); return; }
    if (per.since > per.until) { msg('A data inicial está depois da final.', 'err'); return; }
    lastGen = { account: c.account, t: c.t, since: per.since, until: per.until, label: c.label };

    var btn = document.getElementById('v3-go');
    btn.disabled = true;
    msg('');
    startProgress(force ? 'Atualizando da Meta…' : 'Consultando a Meta…');
    try {
      var data = await callApi({ method: 'POST', body: { account: c.account, since: per.since, until: per.until, t: c.t, label: c.label, refresh: !!force } });
      if (!data.ok) {
        if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) { goToLogin(); return; }
        msg('Não foi possível gerar o relatório: ' + errLine(data) + '<br><span style="opacity:.8">Use <b>baixar diagnóstico (debug)</b> e mande pro suporte.</span>', 'err');
        return;
      }
      if (typeof XLSX === 'undefined' || !window.__render) { msg('O motor do relatório não carregou. Recarregue a página.', 'err'); return; }

      setStage('Montando as páginas…', 93);
      scheduleThumbs((data.extras || {}).thumbs);   // aplicadas quando os slots ficam prontos
      await window.__render.loadFile(aoaToFile(data.main, 'meta-' + per.since + '_' + per.until + '.xlsx'));
      if (data.platform && data.platform.length > 1) {
        await window.__render.loadPlatformFile(aoaToFile(data.platform, 'meta-' + per.since + '-plat.xlsx'));
      }
      if (data.reach && window.__render.applyReach) window.__render.applyReach(data.reach);   // alcance correto (deduplicado por nível)
      setStage('Desenhando os gráficos…', 98);
      var ex = data.extras || {};
      // Nome do cliente no relatório: máscara (nome de exibição) definida pelo usuário
      // vence; senão o nome da Página da Meta; senão o rótulo da conta.
      var clientName = (c.mask && c.mask.trim()) ? c.mask : (ex.pageName || c.label);
      if (window.__render.applyMeta) window.__render.applyMeta({ client: clientName, periodWord: periodWord(per.since, per.until), photo: ex.photo || null });

      renderUsage(data.usage);
      var rows = (data.meta && data.meta.rows_main) || 0;
      var tm = (data.meta && data.meta.thumbs) || null;
      var nThumbs = tm ? (tm.cached + tm.fetched) : 0;
      var warns = [];
      if (!ex.photo) warns.push('foto do profissional não encontrada');
      if (tm && tm.failed > 0) warns.push(tm.failed + ' criativo(s) sem imagem');
      if (tm && tm.low_quality > 0) {
        warns.push(tm.low_quality + ' imagem(ns) em baixa resolução');
        // Alerta explícito: a Meta estrangulou a busca em alta (throttle). Não fica
        // salvo no cache, então basta gerar de novo mais tarde / usar "Atualizar da Meta".
        var nomes = (tm.low_quality_names || []).slice(0, 8).join(', ');
        alert('⚠ ' + tm.low_quality + ' imagem(ns) vieram em BAIXA resolução (a Meta limitou a busca em alta no momento).\n\n'
          + (nomes ? 'Anúncios: ' + nomes + (tm.low_quality_names.length > 8 ? '…' : '') + '\n\n' : '')
          + 'Elas NÃO foram salvas no cache. Use o menu ☰ → "🖼 Recarregar imagens" daqui a pouco para tentar de novo SÓ as imagens (sem repuxar os dados).');
      }
      setOriginBadge(data);
      setStatus(originShort(data) + ' · ' + rows + ' linhas' + (warns.length ? ' · ⚠ ' + warns.join(' · ') : ''));
      // Orientação contextual: foto pelo upload; imagens faltando/baixa qualidade pelo botão de recarregar (só imagens).
      var imgIssue = tm && ((tm.failed || 0) > 0 || (tm.low_quality || 0) > 0);
      var guide = [];
      if (!ex.photo) guide.push('☰ → Foto do profissional');
      if (imgIssue) guide.push('☰ → 🖼 Recarregar imagens');
      msg('✓ Relatório (' + originShort(data) + ', ' + rows + ' linhas' + (tm ? ', ' + nThumbs + ' criativo(s)' : '') + ').'
        + (warns.length ? '<br><span style="color:#ffb454">⚠ ' + esc(warns.join(' · ')) + (guide.length ? ' — use ' + esc(guide.join(' · ')) : '') + '</span>' : ''), 'ok');
      hideOverlay();
      backfillAndAnomaly(c, per);   // histórico (3 meses) em background + modal de anomalias
    } catch (err) {
      msg('Erro: ' + (err && err.message ? err.message : err), 'err');
    } finally {
      btn.disabled = false;
      stopProgress();
    }
  }

  /* Recarrega SÓ as imagens (criativos) faltando ou em baixa resolução do
     relatório aberto, sem repuxar os dados — pra não estourar o consumo da API.
     Reusa o período/cliente da última geração. Acionada pelo menu ☰. */
  async function reloadCreatives() {
    var g = lastGen;
    if (!g) {
      var c = currentClient(), per = currentPeriod();
      if (c && per && per.since && per.until) g = { account: c.account, t: c.t, since: per.since, until: per.until };
    }
    if (!g) { setStatus('Gere um relatório primeiro (Trocar cliente/período) para recarregar as imagens.'); return; }
    setStatus('🖼 Recarregando imagens faltando/baixa qualidade…');
    var data = await callApi({ method: 'POST', body: { account: g.account, since: g.since, until: g.until, t: g.t, action: 'reload_creatives' } });
    if (!data.ok) {
      if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) { goToLogin(); return; }
      setStatus('Não consegui recarregar as imagens: ' + errLine(data));
      return;
    }
    if (data.thumbs) { scheduleThumbs(data.thumbs); applyThumbs(data.thumbs); }
    renderUsage(data.usage);
    var tm = (data.meta && data.meta.thumbs) || {};
    var got = (tm.cached || 0) + (tm.fetched || 0);
    var parts = [got + ' imagem(ns) aplicada(s)'];
    if (tm.failed) parts.push(tm.failed + ' ainda sem imagem');
    if (tm.low_quality) parts.push(tm.low_quality + ' ainda em baixa resolução (a Meta limitou; tente de novo mais tarde)');
    setStatus('🖼 ' + parts.join(' · '));
  }

  /* Re-busca a foto da Página vinculada e salva no perfil; aplica no relatório
     aberto. Acionada pelo menu interno (☰), então o retorno vai para o #rt-status. */
  async function refreshPhoto() {
    var c = currentClient();
    if (!c) { setStatus('Selecione um cliente primeiro (Trocar cliente/período).'); return; }
    setStatus('Buscando a foto da Página…');
    var data = await callApi({ method: 'POST', body: { account: c.account, t: c.t, label: c.label, action: 'refresh_photo' } });
    if (!data.ok) {
      if (data.code === 'AUTH' || data._http === 401) { goToLogin(); return; }
      setStatus('Não consegui buscar a foto: ' + (data.error || '') + ' Use "Foto do profissional (enviar)".');
      return;
    }
    if (window.__render && window.__render.applyMeta) window.__render.applyMeta({ photo: data.photo });
    setStatus('Foto atualizada e salva no perfil.');
  }

  /* Persiste no perfil a foto enviada pelo input do menu (rt-photo). A V2 já
     aplica a imagem localmente no change; aqui só salvamos no banco (sem limpar o
     input, para a V2 conseguir lê-lo). */
  function persistPhotoFromInput(e) {
    var c = currentClient();
    var file = e.target.files && e.target.files[0];
    if (!c || !file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      var data = await callApi({ method: 'POST', body: { account: c.account, t: c.t, label: c.label, action: 'set_photo', photo: reader.result } });
      if (data && data.ok) setStatus('Foto do profissional salva no perfil.');
    };
    reader.readAsDataURL(file);
  }

  /* Baixa um JSON de diagnóstico (totais principal × plataforma, objetivos e
     amostras das linhas cruas) para mandar pro Claude analisar discrepâncias. */
  async function downloadDebug() {
    var c = currentClient();
    var per = currentPeriod();

    // Sem cliente/período (ex.: os perfis nem chegaram a carregar) → exporta o
    // último request/resposta capturado, que é justamente o que mostra o erro.
    if (!c || !per || !per.since || !per.until) {
      if (lastDiag) {
        downloadJson({ tipo: 'diagnostico-v3', gerado_em: new Date().toISOString(), navegador: navigator.userAgent, ultimo_request: lastDiag }, 'v3-diagnostico-' + Date.now() + '.json');
        msg('✓ Diagnóstico baixado (sem cliente/período selecionado) — manda pro suporte.', 'ok');
      } else {
        msg('Ainda não há nada para diagnosticar. Tente carregar os perfis ou gerar um relatório primeiro.', 'err');
      }
      return;
    }

    msg('<span class="v3-spin"></span>Baixando dados de debug…');
    var data = await callApi({ method: 'POST', body: { account: c.account, since: per.since, until: per.until, t: c.t, debug: 2 } });
    if (!data.ok) {
      if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) { goToLogin(); return; }
      downloadJson({ tipo: 'diagnostico-v3', gerado_em: new Date().toISOString(), navegador: navigator.userAgent, erro: data, ultimo_request: lastDiag }, 'v3-erro-' + c.account + '-' + per.since + '_' + per.until + '.json');
      msg('Falha ao baixar o debug: ' + errLine(data) + ' — o diagnóstico do erro foi baixado mesmo assim.', 'err');
      return;
    }
    downloadJson(data, 'v3-debug-' + c.account + '-' + per.since + '_' + per.until + '.json');
    msg('✓ Arquivo de debug baixado — manda pro Claude analisar.', 'ok');
  }

  /* Guarda as thumbs e as aplica quando os slots de imagem terminam de
     reidratar (evento report:slots-ready). Há um fallback por tempo caso o
     motor não emita o sinal. */
  function scheduleThumbs(map) {
    pendingThumbs = (map && typeof map === 'object') ? map : null;
    if (thumbsFallbackTimer) clearTimeout(thumbsFallbackTimer);
    if (pendingThumbs) thumbsFallbackTimer = setTimeout(function () { if (pendingThumbs) applyThumbs(pendingThumbs); }, 2500);
  }

  /* Preenche os slots de criativo com as thumbs, casando pelo nome do anúncio
     (mesma normalização do casamento manual da V2). */
  function applyThumbs(map) {
    if (!map || typeof map !== 'object' || !window.__setSlotImage) return;
    function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, ''); }
    var byNorm = {};
    Object.keys(map).forEach(function (k) { byNorm[norm(k)] = map[k]; });
    document.querySelectorAll('#deck image-slot[data-ad]').forEach(function (slot) {
      var url = byNorm[norm(slot.getAttribute('data-ad'))];
      if (url) window.__setSlotImage(slot, url);
    });
  }

  /* ── origem dos dados (sinalização persistente) ───────────────────────── */
  function fmtWhen(s) { try { return new Date(String(s).replace(' ', 'T')).toLocaleString('pt-BR'); } catch (e) { return s; } }
  function originShort(d) {
    if (!d) return '';
    if (d.origin === 'cache') return '💾 do cache' + (d.cached_at ? ' (' + fmtWhen(d.cached_at) + ')' : '');
    if (d.origin === 'derived') return '💾 derivado do cache (sem nova consulta à Meta)';
    return '⚡ dados ao vivo da Meta';
  }
  function setStatus(txt) { var s = document.getElementById('rt-status'); if (s) s.textContent = txt; }
  function setOriginBadge(d) {
    var el = document.getElementById('v3-origin');
    if (!el) return;
    var live = (d.origin || 'live') === 'live';
    el.className = live ? 'live' : 'cache';
    el.textContent = live ? '⚡ ao vivo' : '💾 cache';
    el.title = originShort(d);
    el.style.display = 'block';
  }

  /* ── menu interno do V3 (botões específicos da toolbar) ────────────────── */
  function wireV3Menu() {
    var on = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
    on('v3-mn-reopen', showOverlay);
    on('v3-mn-refresh', function () { showOverlay(); generate(true); });
    on('v3-mn-anom', openAnomaly);
    on('v3-mn-profiles', openProfileModal);
    on('v3-mn-reload-img', reloadCreatives);
    on('v3-mn-photo-auto', refreshPhoto);
    var rp = document.getElementById('rt-photo');
    if (rp) rp.addEventListener('change', persistPhotoFromInput);   // persiste no perfil além do apply local da V2
  }

  /* ── gerenciador de perfis (modal da tela inicial e do menu) ──────────── */
  function ensureProfileModal() {
    var ov = document.getElementById('v3-pm');
    if (ov) return ov;
    ov = document.createElement('div'); ov.id = 'v3-pm';
    ov.innerHTML = '<div class="v3-pm-card">'
      + '<div class="v3-pm-head"><h2>Perfis dos clientes</h2><button id="v3-pm-close" title="Fechar">✕</button></div>'
      + '<div id="v3-pm-body"></div></div>';
    document.body.appendChild(ov);
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.style.display = 'none'; });
    document.getElementById('v3-pm-close').addEventListener('click', function () { ov.style.display = 'none'; });
    return ov;
  }
  async function openProfileModal() {
    var ov = ensureProfileModal();
    ov.style.display = 'flex';
    var body = document.getElementById('v3-pm-body');
    body.innerHTML = '<div class="v3-pm-load"><span class="v3-spin"></span>Carregando perfis…</div>';
    var data = await callApi({ method: 'POST', body: { action: 'profiles_overview' } });
    if (!data.ok) {
      if (data._http === 401 || data.code === 'AUTH') { goToLogin(); return; }
      body.innerHTML = '<p class="v3-pm-err">Falha ao carregar: ' + errLine(data) + '</p>';
      return;
    }
    if (!data.store) { body.innerHTML = '<p class="v3-pm-empty">O banco de cache não está disponível no servidor — ainda não há perfis salvos.</p>'; return; }
    renderProfiles(body, data.profiles || [], data.usage);
  }
  function renderProfiles(body, profiles, usage) {
    var head = usage ? '<div class="v3-pm-usage">Consumo da API Meta hoje: <b>' + (usage.max_buc || 0) + '%</b> · ' + (usage.calls || 0) + ' chamada(s) ao vivo</div>' : '';
    if (!profiles.length) { body.innerHTML = head + '<p class="v3-pm-empty">Nenhum perfil salvo ainda. Gere um relatório para criar o primeiro.</p>'; return; }
    var search = '<input type="text" id="v3-pm-search" placeholder="🔎 Buscar perfil pelo nome…" autocomplete="off">';
    body.innerHTML = head + search + '<div id="v3-pm-list">' + profiles.map(function (p) {
      var nome = (p.mask && p.mask.trim()) ? p.mask : p.label;       // o que é exibido
      var searchTxt = ((p.mask || '') + ' ' + (p.label || '') + ' ' + (p.bm || '')).toLowerCase();
      var periods = (p.reports || []).map(function (r) {
        return '<span class="v3-pm-period' + (r.is_final ? '' : ' open') + '" title="' + (r.is_final ? 'consolidado' : 'parcial') + ' · salvo ' + esc(fmtWhen(r.fetched_at)) + '">' + esc(r.since) + ' → ' + esc(r.until) + '</span>';
      }).join('');
      var photo = '<div class="v3-pm-photo empty">' + (p.has_photo ? 'foto<br>salva' : 'sem<br>foto') + '</div>';
      // Editor inline: nome de exibição (máscara) + foto. data-bm garante a chave certa por BM.
      var maskVal = (p.mask && p.mask.trim()) ? p.mask : '';
      var editor = '<div class="v3-pm-edit" hidden>'
        + '<label>Nome de exibição (aparece no relatório e no seletor)</label>'
        + '<div class="v3-pm-namerow">'
        + '<input type="text" class="v3-pm-name-in" maxlength="120" placeholder="ex.: ' + esc(p.label) + '" value="' + esc(maskVal) + '">'
        + '<button class="v3-pm-save" data-act="savename" type="button">Salvar</button>'
        + '</div>'
        + '<div class="v3-pm-hint">Conta na Meta: <b>' + esc(p.label) + '</b>' + (p.bm ? ' · BM: ' + esc(p.bm) : '') + '. Deixe em branco para usar o nome da Página da Meta.</div>'
        + '<div class="v3-pm-photo-row">'
        + '<button class="v3-pm-fbtn" data-act="photo" type="button">📷 ' + (p.has_photo ? 'Trocar foto' : 'Enviar foto') + '</button>'
        + (p.has_photo ? '<button class="v3-pm-fbtn" data-act="rmphoto" type="button">Remover foto</button>' : '')
        + '<input type="file" class="v3-pm-photo-in" accept="image/*" hidden>'
        + '</div>'
        + '<div class="v3-pm-save-msg"></div>'
        + '</div>';
      return '<div class="v3-pm-item" data-acc="' + esc(p.account_id) + '" data-bm="' + esc(p.bm || '') + '" data-search="' + esc(searchTxt) + '">'
        + photo
        + '<div class="v3-pm-info">'
        + '<div class="v3-pm-name">' + esc(nome) + (p.bm ? ' <span class="v3-pm-bm">· ' + esc(p.bm) + '</span>' : '') + '</div>'
        + '<div class="v3-pm-meta">' + p.reports_count + ' relatório(s) em cache · ' + p.creatives_count + ' criativo(s)'
        + (p.photo_source ? ' · foto: ' + esc(p.photo_source) : ' · sem foto') + '</div>'
        + '<div class="v3-pm-periods">' + (periods || '<span class="v3-pm-none">nenhum período em cache</span>') + '</div>'
        + '<div class="v3-pm-actions">'
        + '<button data-act="edit" type="button">✎ Editar perfil</button>'
        + '<button data-act="thumbs" type="button">Ver criativos (' + p.creatives_count + ')</button>'
        + '<button data-act="clear" type="button">Limpar cache</button>'
        + '</div>'
        + editor
        + '<div class="v3-pm-gallery" hidden></div>'
        + '</div></div>';
    }).join('') + '</div>';
    body.querySelectorAll('.v3-pm-item').forEach(function (item) {
      var acc = item.getAttribute('data-acc');
      var bm = item.getAttribute('data-bm') || '';
      item.querySelectorAll('button[data-act]').forEach(function (b) {
        b.addEventListener('click', function () { profileAction(b.getAttribute('data-act'), acc, item, bm); });
      });
      var fin = item.querySelector('.v3-pm-photo-in');
      if (fin) fin.addEventListener('change', function (e) { uploadProfilePhoto(e, acc, bm, item); });
    });
    // Busca: filtra os itens conforme o texto digitado.
    var si = document.getElementById('v3-pm-search');
    if (si) si.addEventListener('input', function () {
      var q = si.value.trim().toLowerCase();
      var any = false;
      body.querySelectorAll('.v3-pm-item').forEach(function (item) {
        var hit = !q || (item.getAttribute('data-search') || '').indexOf(q) >= 0;
        item.style.display = hit ? '' : 'none';
        if (hit) any = true;
      });
      var empty = document.getElementById('v3-pm-empty-search');
      if (!any && !empty) { var d = document.createElement('div'); d.id = 'v3-pm-empty-search'; d.className = 'v3-pm-empty-search'; d.textContent = 'Nenhum perfil encontrado para “' + si.value + '”.'; document.getElementById('v3-pm-list').appendChild(d); }
      else if (any && empty) empty.remove();
    });
  }
  async function profileAction(act, account, item, bm) {
    if (act === 'edit') {
      var ed = item.querySelector('.v3-pm-edit');
      if (ed) { ed.hidden = !ed.hidden; if (!ed.hidden) { var inp = ed.querySelector('.v3-pm-name-in'); if (inp) inp.focus(); } }
      return;
    }
    if (act === 'savename') {
      var ed2 = item.querySelector('.v3-pm-edit');
      var inp2 = ed2 && ed2.querySelector('.v3-pm-name-in');
      var msg2 = ed2 && ed2.querySelector('.v3-pm-save-msg');
      var val = inp2 ? inp2.value.trim() : '';
      if (msg2) { msg2.className = 'v3-pm-save-msg'; msg2.textContent = 'Salvando…'; }
      var r = await callApi({ method: 'POST', body: { account: account, bm: bm, action: 'set_display_name', display_name: val } });
      if (r && r.ok) {
        if (msg2) { msg2.className = 'v3-pm-save-msg ok'; msg2.textContent = '✓ Nome salvo.'; }
        var nameEl = item.querySelector('.v3-pm-name');
        if (nameEl) nameEl.innerHTML = esc(val || (item.getAttribute('data-search') || '').split(' ')[0]) + (bm ? ' <span class="v3-pm-bm">· ' + esc(bm) + '</span>' : '');
        // Atualiza o seletor da tela inicial sem recarregar tudo.
        var sel = document.getElementById('v3-acc');
        if (sel) for (var i = 0; i < sel.options.length; i++) {
          var o = sel.options[i];
          if (o.value === account) { o.setAttribute('data-mask', val); var lbl = o.getAttribute('data-label') || ''; o.textContent = (val || lbl); break; }
        }
      } else if (msg2) { msg2.className = 'v3-pm-save-msg err'; msg2.textContent = 'Falha ao salvar: ' + errLine(r); }
      return;
    }
    if (act === 'photo') {
      var fin2 = item.querySelector('.v3-pm-photo-in');
      if (fin2) fin2.click();
      return;
    }
    if (act === 'thumbs') {
      var gal = item.querySelector('.v3-pm-gallery');
      if (!gal.hidden) { gal.hidden = true; return; }
      gal.hidden = false; gal.innerHTML = '<span class="v3-spin"></span> carregando…';
      var data = await callApi({ method: 'POST', body: { account: account, action: 'creatives' } });
      var cs = (data && data.creatives) || [];
      gal.innerHTML = cs.length
        ? cs.map(function (c) { return '<figure><img src="' + c.url + '" loading="lazy" alt=""><figcaption title="' + esc(c.name) + '">' + esc(c.name) + '</figcaption></figure>'; }).join('')
        : '<span class="v3-pm-none">nenhum criativo salvo</span>';
      return;
    }
    if (act === 'clear') {
      if (!confirm('Apagar os relatórios e criativos em cache deste perfil? A foto e o nome são mantidos.')) return;
      await callApi({ method: 'POST', body: { account: account, action: 'clear_profile' } });
      openProfileModal();
      return;
    }
    if (act === 'rmphoto') {
      if (!confirm('Remover a foto do profissional deste perfil?')) return;
      await callApi({ method: 'POST', body: { account: account, bm: bm, action: 'remove_photo' } });
      openProfileModal();
      return;
    }
  }
  /* Lê a imagem escolhida no editor de perfil e salva no perfil (set_photo). */
  function uploadProfilePhoto(e, account, bm, item) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var msg = item.querySelector('.v3-pm-save-msg');
    if (msg) { msg.className = 'v3-pm-save-msg'; msg.textContent = 'Enviando foto…'; }
    var reader = new FileReader();
    reader.onload = async function () {
      var r = await callApi({ method: 'POST', body: { account: account, bm: bm, action: 'set_photo', photo: reader.result } });
      if (r && r.ok) {
        if (msg) { msg.className = 'v3-pm-save-msg ok'; msg.textContent = '✓ Foto salva no perfil.'; }
        var av = item.querySelector('.v3-pm-photo');
        if (av) { av.classList.remove('empty'); av.innerHTML = ''; av.style.background = 'url(' + r.photo + ') center/cover no-repeat'; }
      } else if (msg) { msg.className = 'v3-pm-save-msg err'; msg.textContent = 'Falha ao salvar a foto: ' + errLine(r); }
      e.target.value = '';
    };
    reader.readAsDataURL(file);
  }

  /* ── histórico (3 meses) + anomalias ──────────────────────────────────── */
  function monthBefore(sinceStr, n) {
    var p = String(sinceStr).split('-');
    var d = new Date(+p[0], (+p[1] - 1) - n, 1);
    return monthRange(d.getFullYear() + '-' + pad2(d.getMonth() + 1));
  }
  /* Estado da análise de mudanças (anomalias) — para o botão do menu ☰ e o aviso
     flutuante poderem refletir "analisando / concluído / sem mudanças". */
  var lastAnomaly = null;        // último resultado, para reabrir pelo menu
  var anomalyState = 'idle';     // idle | na | analyzing | changes | clean | error

  /* Mostra o mês pedido rápido; aqui, em BACKGROUND, salva os 2 meses anteriores
     (só dados, sem imagem) e depois compara o atual com o anterior (anomalias).
     Só roda no modo Mensal — a comparação mês a mês é o que faz sentido. */
  async function backfillAndAnomaly(c, per) {
    if (periodType !== 'mensal') { anomalyState = 'na'; lastAnomaly = null; return; }
    anomalyState = 'analyzing'; lastAnomaly = null;
    anomalyToast('analyzing');
    var m1 = monthBefore(per.since, 1), m2 = monthBefore(per.since, 2);
    for (var i = 0; i < 2; i++) {
      var mm = i === 0 ? m1 : m2;
      try { await callApi({ method: 'POST', body: { account: c.account, since: mm.since, until: mm.until, t: c.t, label: c.label, prefetch: true } }); } catch (e) {}
    }
    try {
      var an = await callApi({ method: 'POST', body: { account: c.account, since: per.since, until: per.until, t: c.t, action: 'anomaly' } });
      lastAnomaly = (an && an.ok) ? an : null;
      if (an && an.ok && an.anomalies && an.anomalies.length) {
        anomalyState = 'changes';
        anomalyToast('changes', an.anomalies.length);
        showAnomalyModal(an);
      } else {
        anomalyState = 'clean';
        anomalyToast('clean');
      }
    } catch (e) { anomalyState = 'error'; anomalyToast('error'); }
  }

  /* Abre o modal de anomalias sob demanda (botão do menu ☰). Reflete o estado
     atual: reabre as mudanças, mostra "sem mudanças" ou orienta com um toast. */
  function openAnomaly() {
    if (anomalyState === 'analyzing') { anomalyToast('analyzing'); return; }
    if (lastAnomaly && lastAnomaly.anomalies && lastAnomaly.anomalies.length) { showAnomalyModal(lastAnomaly); return; }
    if (anomalyState === 'clean') { showAnomalyModal({ ok: true, anomalies: [] }); return; }
    if (anomalyState === 'na') { anomalyToast('na'); return; }
    if (anomalyState === 'error') { anomalyToast('error'); return; }
    anomalyToast('idle');
  }

  function showAnomalyModal(an) {
    var ov = document.getElementById('v3-anom');
    if (!ov) { ov = document.createElement('div'); ov.id = 'v3-anom'; ov.className = 'export-hidden'; document.body.appendChild(ov); }
    var list = (an && an.anomalies) || [];
    var body;
    if (list.length) {
      var items = list.map(function (a) {
        var cls = a.dir === 'queda' ? 'down' : (a.dir === 'alta' ? 'up' : 'shift');
        var vs = (a.antes != null && a.agora != null) ? '<span class="v3-anom-vs">' + esc(String(a.antes)) + ' <i>→</i> ' + esc(String(a.agora)) + '</span>' : '';
        return '<div class="v3-anom-item ' + cls + '"><div class="v3-anom-txt">' + esc(a.texto) + '</div>' + vs + '</div>';
      }).join('');
      body = '<p class="v3-anom-sub">A Meta reorganiza orçamento e públicos sozinha. Confira se as mudanças abaixo fazem sentido — pode ser só o algoritmo otimizando.</p>'
        + '<div class="v3-anom-list">' + items + '</div>';
    } else {
      body = '<div class="v3-anom-clean">✓ Nenhuma mudança relevante vs. o mês anterior. Os números seguem a tendência — nada que peça atenção.</div>';
    }
    ov.innerHTML = '<div class="v3-anom-card">'
      + '<div class="v3-anom-head"><h2>Mudanças vs. mês anterior</h2><span class="v3-anom-only">só você vê isto · não vai no PDF</span></div>'
      + body
      + '<button class="v3-anom-ok" id="v3-anom-ok">Entendi e confirmo</button>'
      + '</div>';
    ov.style.display = 'flex';
    document.getElementById('v3-anom-ok').addEventListener('click', function () { ov.style.display = 'none'; });
  }

  /* Aviso flutuante (toast) — aparece e some sozinho; nunca entra no PDF. */
  var toastTimer = null;
  function toastEl() {
    var t = document.getElementById('v3-toast');
    if (!t) { t = document.createElement('div'); t.id = 'v3-toast'; t.className = 'export-hidden'; document.body.appendChild(t); }
    return t;
  }
  function showToast(html, opts) {
    opts = opts || {};
    var t = toastEl();
    if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
    t.className = 'export-hidden' + (opts.warn ? ' warn' : '') + (opts.onClick ? ' clickable' : '');
    t.innerHTML = (opts.sticky ? '<span class="v3-toast-dot"></span>' : '') + '<span>' + html + '</span>';
    t.onclick = opts.onClick || null;
    void t.offsetWidth;          // força reflow para animar a entrada
    t.classList.add('show');
    if (!opts.sticky) toastTimer = setTimeout(hideToast, opts.ms || 5000);
  }
  function hideToast() { var t = document.getElementById('v3-toast'); if (t) t.classList.remove('show'); }
  function anomalyToast(kind, n) {
    if (kind === 'analyzing') showToast('Analisando mudanças vs. mês anterior…', { sticky: true });
    else if (kind === 'changes') showToast('⚠ ' + n + ' mudança' + (n > 1 ? 's' : '') + ' vs. mês anterior · toque para ver', { ms: 8000, warn: true, onClick: function () { hideToast(); if (lastAnomaly) showAnomalyModal(lastAnomaly); } });
    else if (kind === 'clean') showToast('✓ Sem mudanças relevantes vs. mês anterior', { ms: 5000 });
    else if (kind === 'error') showToast('Não consegui analisar as mudanças agora', { ms: 5000, warn: true });
    else if (kind === 'na') showToast('A análise de mudanças só vale no período Mensal.', { ms: 5000 });
    else showToast('Gere um relatório mensal para analisar as mudanças.', { ms: 5000 });
  }

  /* ── inicialização ────────────────────────────────────────────────────── */
  function init() {
    try { console.log('%c[V3] frontend build ' + V3_BUILD, 'color:#32cdcd;font-weight:700'); } catch (e) {}
    var ss = document.getElementById('start-screen'); // esconde o upload da V2
    if (ss) { ss.classList.add('hidden'); ss.style.display = 'none'; }
    document.addEventListener('report:slots-ready', function () { if (pendingThumbs) applyThumbs(pendingThumbs); });
    buildOverlay();
    wireV3Menu();          // botões específicos do V3 no menu interno (☰)
    loadAccounts(false);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
