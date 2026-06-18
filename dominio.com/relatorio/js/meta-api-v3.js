/**
 * Relatório V3 — fonte de dados via API da Meta (Graph API).
 *
 * Diferente da V1/V2 (que sobem Excel à mão), a V3 puxa os números direto da
 * conta de anúncios. Este arquivo NÃO reimplementa o relatório: ele apenas
 *   1. pede ao backend (api/v3-meta-insights.php) os dados do mês escolhido;
 *   2. transforma a resposta em uma planilha (igual a um Excel exportado); e
 *   3. entrega essa planilha ao motor da V2 (window.__render.loadFile), que já
 *      sabe desenhar tudo. Assim a V2 fica 100% intacta.
 *
 * Segurança: o token da Meta vive só no servidor; aqui só falamos com o nosso
 * próprio backend (mesma origem), que exige login do sistema.
 */
(function () {
  'use strict';

  var API = 'api/v3-meta-insights.php';
  var csrf = '';
  var accountsLoaded = false;

  /* ── utilidades ───────────────────────────────────────────────────────── */
  function pad2(n) { return String(n).padStart(2, '0'); }
  function ym(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function lastMonth() { var d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return ym(d); }
  function thisMonth() { return ym(new Date()); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function goToLogin() { window.location.href = '/'; }   // não logado → tela de login do sistema
  function downloadJson(obj, name) {
    var blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ── período (atalhos + intervalo personalizado) ──────────────────────── */
  function fmtDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function setRange(s, u) { document.getElementById('v3-since').value = fmtDate(s); document.getElementById('v3-until').value = fmtDate(u); }
  function applyPreset(p) {
    var today = new Date(), s, u;
    if (p === 'mes') {                       // último mês completo
      s = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      u = new Date(today.getFullYear(), today.getMonth(), 0);
    } else {                                 // janelas terminando ontem
      u = new Date(today); u.setDate(u.getDate() - 1);
      s = new Date(u);
      if (p === 'quinzena') s.setDate(s.getDate() - 14);
      else if (p === 'd10') s.setDate(s.getDate() - 9);
      // 'dia' → s == u (um dia)
    }
    setRange(s, u);
    document.querySelectorAll('#v3-presets button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-preset') === p); });
  }
  function clearPreset() { document.querySelectorAll('#v3-presets button').forEach(function (b) { b.classList.remove('on'); }); }
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

  async function callApi(opts) {
    opts = opts || {};
    var init = { method: opts.method || 'GET', credentials: 'same-origin', headers: {} };
    if (opts.body) {
      init.headers['Content-Type'] = 'application/json';
      init.headers['X-CSRF-Token'] = csrf;
      init.body = JSON.stringify(opts.body);
    }
    var res = await fetch(API + (opts.query || ''), init);
    var data;
    try { data = await res.json(); } catch (e) { data = { ok: false, error: 'Resposta inválida do servidor.', code: 'BAD_JSON' }; }
    data._http = res.status;
    return data;
  }

  /* ── overlay (tela de seleção) ────────────────────────────────────────── */
  function injectStyles() {
    if (document.getElementById('v3-style')) return;
    var css = ''
      + '#v3-screen{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;'
      + 'background:radial-gradient(1200px 800px at 70% -10%,#13344a,#0a1b26 60%);font-family:"Open Sans",system-ui,sans-serif;color:#eaf4f6}'
      + '#v3-screen .v3-card{width:min(560px,92vw);background:#0e2330;border:1px solid rgba(50,205,205,.25);border-radius:18px;'
      + 'padding:30px 32px;box-shadow:0 24px 60px rgba(0,0,0,.45)}'
      + '#v3-screen .v3-brand{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#32cdcd;font-weight:700;margin-bottom:6px}'
      + '#v3-screen h1{font-size:24px;font-weight:800;margin:0 0 4px}'
      + '#v3-screen p.v3-sub{margin:0 0 22px;font-size:14px;line-height:1.5;color:#9fc1c9}'
      + '#v3-screen label{display:block;font-size:12px;font-weight:600;color:#9fc1c9;margin:0 0 6px;letter-spacing:.02em}'
      + '#v3-screen select,#v3-screen input[type=month],#v3-screen input[type=date]{width:100%;box-sizing:border-box;background:#08171f;color:#eaf4f6;'
      + 'border:1px solid rgba(255,255,255,.16);border-radius:10px;padding:12px 14px;font-size:15px;margin-bottom:18px}'
      + '#v3-screen input[type=date]{color-scheme:dark}'
      + '#v3-screen .v3-presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}'
      + '#v3-screen .v3-presets button{flex:1;min-width:70px;background:#08171f;color:#9fc1c9;border:1px solid rgba(255,255,255,.16);'
      + 'border-radius:8px;padding:9px 6px;font:600 13px "Open Sans",sans-serif;cursor:pointer}'
      + '#v3-screen .v3-presets button.on{background:#32cdcd;color:#06222a;border-color:#32cdcd}'
      + '#v3-screen .v3-row{display:flex;gap:14px}#v3-screen .v3-row>div{flex:1}'
      + '#v3-screen .v3-btn{width:100%;border:0;border-radius:10px;padding:14px;font-size:15px;font-weight:700;cursor:pointer;'
      + 'background:#32cdcd;color:#06222a;transition:filter .15s}#v3-screen .v3-btn:hover{filter:brightness(1.07)}'
      + '#v3-screen .v3-btn:disabled{opacity:.5;cursor:not-allowed}'
      + '#v3-screen .v3-btn.alt{background:transparent;color:#32cdcd;border:1px solid rgba(50,205,205,.4);margin-top:10px}'
      + '#v3-screen .v3-msg{min-height:20px;margin-top:16px;font-size:13.5px;line-height:1.5;color:#9fc1c9}'
      + '#v3-screen .v3-msg.err{color:#ff9a9a}#v3-screen .v3-msg.ok{color:#7fe3c0}'
      + '#v3-screen .v3-dbg{display:block;text-align:center;margin-top:14px;font-size:12px;color:#6f8a93;text-decoration:underline;cursor:pointer}'
      + '#v3-reopen{position:fixed;left:14px;bottom:14px;z-index:8000;background:#0e2330;color:#32cdcd;border:1px solid rgba(50,205,205,.4);'
      + 'border-radius:999px;padding:9px 16px;font:600 13px/1 "Open Sans",sans-serif;cursor:pointer;display:none}'
      + '#v3-screen .v3-spin{display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,.25);border-top-color:#32cdcd;'
      + 'border-radius:50%;animation:v3spin .8s linear infinite;vertical-align:-2px;margin-right:7px}'
      + '@keyframes v3spin{to{transform:rotate(360deg)}}';
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
      + '  <p class="v3-sub">Escolha o cliente e o mês. Os números vêm automaticamente da conta de anúncios — sem exportar Excel.</p>'
      + '  <div id="v3-form">'
      + '    <label for="v3-acc">Cliente (conta de anúncios)</label>'
      + '    <select id="v3-acc"><option>Carregando…</option></select>'
      + '    <label>Período</label>'
      + '    <div id="v3-presets" class="v3-presets">'
      + '      <button type="button" data-preset="mes">Mês</button>'
      + '      <button type="button" data-preset="quinzena">Quinzena</button>'
      + '      <button type="button" data-preset="d10">10 dias</button>'
      + '      <button type="button" data-preset="dia">Diário</button>'
      + '    </div>'
      + '    <div class="v3-row">'
      + '      <div><label for="v3-since">De</label><input type="date" id="v3-since"></div>'
      + '      <div><label for="v3-until">Até</label><input type="date" id="v3-until"></div>'
      + '    </div>'
      + '    <button class="v3-btn" id="v3-go" disabled>Gerar relatório</button>'
      + '  </div>'
      + '  <div class="v3-msg" id="v3-msg"></div>'
      + '  <a href="#" id="v3-dbg" class="v3-dbg">baixar dados (debug)</a>'
      + '  <div id="v3-login" style="display:none">'
      + '    <button class="v3-btn" id="v3-login-open">Fazer login</button>'
      + '    <button class="v3-btn alt" id="v3-login-retry">Já entrei — tentar de novo</button>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(wrap);

    var reopen = document.createElement('button');
    reopen.id = 'v3-reopen';
    reopen.textContent = '↻ Trocar cliente/mês';
    reopen.addEventListener('click', showOverlay);
    document.body.appendChild(reopen);

    applyPreset('mes');   // padrão: último mês completo
    document.querySelectorAll('#v3-presets button').forEach(function (b) { b.addEventListener('click', function () { applyPreset(b.getAttribute('data-preset')); }); });
    document.getElementById('v3-since').addEventListener('change', clearPreset);
    document.getElementById('v3-until').addEventListener('change', clearPreset);
    document.getElementById('v3-go').addEventListener('click', generate);
    document.getElementById('v3-dbg').addEventListener('click', function (e) { e.preventDefault(); downloadDebug(); });
    document.getElementById('v3-login-open').addEventListener('click', function () { window.open('/', '_blank'); });
    document.getElementById('v3-login-retry').addEventListener('click', loadAccounts);
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

  /* ── fluxo ────────────────────────────────────────────────────────────── */
  async function loadAccounts() {
    showLogin(false);
    msg('<span class="v3-spin"></span>Verificando login e contas…');
    var data = await callApi({ method: 'GET' });
    if (!data.ok) {
      if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) {
        goToLogin();   // não está logado → vai direto pra tela de login do sistema
        return;
      }
      if (data.code === 'NOT_CONFIGURED') { msg('A API da Meta ainda não foi configurada no servidor. Veja <b>relatorio/DEPLOY-V3.md</b>.', 'err'); return; }
      msg(data.error || 'Falha ao carregar contas.', 'err');
      return;
    }
    csrf = data.csrf || '';
    accountsLoaded = true;
    var sel = document.getElementById('v3-acc');
    var accts = data.accounts || [];
    if (!accts.length) {
      sel.innerHTML = '<option value="">(nenhuma conta)</option>';
      msg('Nenhuma conta acessível pelo token. Confira a parceria/atribuição da conta ao Usuário do Sistema (ou preencha META_ACCOUNTS). Veja <b>relatorio/DEPLOY-V3.md</b>.', 'err');
      return;
    }
    var multi = !!data.multi;   // mais de uma BM → mostra de qual cada conta veio
    sel.innerHTML = accts.map(function (a) {
      var lbl = esc(a.label) + (multi && a.bm ? ' · ' + esc(a.bm) : '');
      return '<option value="' + esc(a.act_id) + '" data-t="' + (a.t || 0) + '" data-label="' + esc(a.label) + '">' + lbl + '</option>';
    }).join('');
    document.getElementById('v3-go').disabled = false;
    msg('Pronto (' + accts.length + ' conta' + (accts.length > 1 ? 's' : '') + (data.auto ? ', lista automática da Meta' : '') + '). Escolha o cliente e o mês e clique em <b>Gerar relatório</b>.');
  }

  async function generate() {
    if (!accountsLoaded) { await loadAccounts(); return; }
    var sel = document.getElementById('v3-acc');
    var account = sel.value;
    var opt = sel.options[sel.selectedIndex];
    var t = opt ? Number(opt.getAttribute('data-t') || 0) : 0;   // qual BM/token
    var since = document.getElementById('v3-since').value;
    var until = document.getElementById('v3-until').value;
    var clientName = opt ? (opt.getAttribute('data-label') || '') : '';
    if (!account) { msg('Selecione um cliente.', 'err'); return; }
    if (!since || !until) { msg('Escolha o período (de / até).', 'err'); return; }

    var btn = document.getElementById('v3-go');
    btn.disabled = true;
    msg('<span class="v3-spin"></span>Consultando a Meta e montando o relatório… (pode levar alguns segundos)');
    try {
      var data = await callApi({ method: 'POST', body: { account: account, since: since, until: until, t: t } });
      if (!data.ok) {
        if (data.code === 'AUTH' || data.code === 'SESSION_EXPIRED' || data._http === 401) { goToLogin(); return; }
        msg(data.error || 'Não foi possível gerar o relatório.', 'err');
        return;
      }
      if (typeof XLSX === 'undefined' || !window.__render) { msg('O motor do relatório não carregou. Recarregue a página.', 'err'); return; }

      await window.__render.loadFile(aoaToFile(data.main, 'meta-' + since + '_' + until + '.xlsx'));
      if (data.platform && data.platform.length > 1) {
        await window.__render.loadPlatformFile(aoaToFile(data.platform, 'meta-' + since + '-plat.xlsx'));
      }
      var ex = data.extras || {};
      if (window.__render.applyMeta) window.__render.applyMeta({ client: ex.pageName || clientName, periodWord: periodWord(since, until), photo: ex.photo || null });
      applyThumbs(ex.thumbs);
      var m = data.meta || {};
      msg('✓ Relatório gerado (' + (m.rows_main || 0) + ' linhas).', 'ok');
      hideOverlay();
    } catch (err) {
      msg('Erro: ' + (err && err.message ? err.message : err), 'err');
    } finally {
      btn.disabled = false;
    }
  }

  /* Baixa um JSON de diagnóstico (totais principal × plataforma, objetivos e
     amostras das linhas cruas) para mandar pro Claude analisar discrepâncias. */
  async function downloadDebug() {
    var sel = document.getElementById('v3-acc');
    var account = sel.value;
    var opt = sel.options[sel.selectedIndex];
    var t = opt ? Number(opt.getAttribute('data-t') || 0) : 0;
    var since = document.getElementById('v3-since').value;
    var until = document.getElementById('v3-until').value;
    if (!account || !since || !until) { msg('Escolha o cliente e o período primeiro.', 'err'); return; }
    msg('<span class="v3-spin"></span>Baixando dados de debug…');
    var data = await callApi({ method: 'POST', body: { account: account, since: since, until: until, t: t, debug: 2 } });
    if (!data.ok) {
      if (data._http === 401) { goToLogin(); return; }
      msg(data.error || 'Falha ao baixar o debug.', 'err');
      return;
    }
    downloadJson(data, 'v3-debug-' + account + '-' + month + '.json');
    msg('✓ Arquivo de debug baixado — manda pro Claude analisar.', 'ok');
  }

  /* #5 — preenche os slots de criativo com as thumbs da API, casando pelo nome
     do anúncio (mesma normalização do casamento manual da V2). */
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

  /* ── inicialização ────────────────────────────────────────────────────── */
  function init() {
    var ss = document.getElementById('start-screen'); // esconde o upload da V2
    if (ss) { ss.classList.add('hidden'); ss.style.display = 'none'; }
    buildOverlay();
    loadAccounts();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
