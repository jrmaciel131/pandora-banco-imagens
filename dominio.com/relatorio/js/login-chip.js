/**
 * Chip de login do sistema — mostra, no canto das páginas do relatório, quem
 * está logado (estilo rede social) com opção de sair. Se não estiver logado,
 * mostra "Fazer login". Compartilha a sessão (bi_session) com o sistema.
 *
 * Incluído em index.html, Relatorio Dinamico.html (V1), RelatorioV2.html e
 * RelatorioV3.html. Esconde-se na impressão (não aparece no PDF).
 */
(function () {
  'use strict';
  var API = 'api/session.php';
  var csrf = '';

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function injectStyle() {
    var css = '#login-chip{position:fixed;top:12px;left:14px;z-index:9500;font-family:"Open Sans",system-ui,sans-serif}'
      + '#login-chip button{font:600 13px "Open Sans",sans-serif;cursor:pointer}'
      + '#lc-btn{display:flex;align-items:center;gap:8px;background:rgba(14,35,48,.92);color:#eaf4f6;border:1px solid rgba(50,205,205,.35);border-radius:999px;padding:6px 12px 6px 7px}'
      + '#lc-av{width:24px;height:24px;border-radius:50%;background:#32cdcd;color:#06222a;display:flex;align-items:center;justify-content:center;font-weight:800}'
      + '#lc-menu{display:none;position:absolute;left:0;margin-top:6px;background:#0e2330;border:1px solid rgba(255,255,255,.12);border-radius:10px;overflow:hidden;min-width:150px}'
      + '#lc-menu button{width:100%;text-align:left;background:none;border:0;color:#ff9a9a;padding:10px 14px}'
      + '#lc-menu button:hover{background:rgba(255,255,255,.06)}'
      + '#lc-login{background:rgba(14,35,48,.92);color:#32cdcd;border:1px solid rgba(50,205,205,.4);border-radius:999px;padding:7px 14px}'
      + '@media print{#login-chip{display:none!important}}';
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  function build(logged, user) {
    var wrap = document.createElement('div');
    wrap.id = 'login-chip';
    if (logged) {
      var ini = (user || '?').charAt(0).toUpperCase();
      wrap.innerHTML =
        '<button id="lc-btn"><span id="lc-av">' + esc(ini) + '</span><span>' + esc(user || '') + '</span><span style="opacity:.6">▾</span></button>'
        + '<div id="lc-menu"><button id="lc-out">Sair</button></div>';
    } else {
      wrap.innerHTML = '<button id="lc-login">Fazer login</button>';
    }
    document.body.appendChild(wrap);

    if (logged) {
      var menu = document.getElementById('lc-menu');
      document.getElementById('lc-btn').addEventListener('click', function (e) {
        e.stopPropagation();
        menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
      });
      document.addEventListener('click', function (e) { if (!wrap.contains(e.target)) menu.style.display = 'none'; });
      document.getElementById('lc-out').addEventListener('click', logout);
    } else {
      document.getElementById('lc-login').addEventListener('click', function () { window.location.href = '/'; });
    }
  }

  async function logout() {
    try {
      await fetch(API, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        body: JSON.stringify({ logout: 1 }),
      });
    } catch (e) { /* ignora — vai pro login de qualquer forma */ }
    window.location.href = '/';
  }

  async function init() {
    injectStyle();
    var data;
    try { data = await (await fetch(API, { credentials: 'same-origin' })).json(); }
    catch (e) { return; }   // sem backend (ex.: aberto como arquivo) → não mostra nada
    csrf = data.csrf || '';
    build(!!data.logged, data.user);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
