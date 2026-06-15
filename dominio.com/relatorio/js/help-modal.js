/* ─────────────────────────────────────────────────────────────────
   help-modal.js — guia rápido mostrado ao ENTRAR no relatório.
   • Visual alinhado ao modal "Como exportar" (#export-help): card escuro
     #121212, realce na cor de destaque e fonte do relatório (Montserrat),
     herdadas via var(--font)/--accent/--ink/--ink-soft/--line.
   • Funciona em V1 e V2 (detecta a versão pela presença do #rt-photo,
     que só existe na V2) e adapta os passos.
   • Caixinha "Não mostrar novamente": ao marcar, fecha e grava no navegador.
   • Botão "❓ Ajuda" no menu (#rt-help) reabre quando quiser.
   ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  // V2 tem o botão "Foto do profissional"; a V1 não.
  const VARIANT = document.getElementById('rt-photo') ? 'v2' : 'v1';
  const SKIP_KEY = 'relatorio_help_skip_' + VARIANT;

  const skipped = () => { try { return localStorage.getItem(SKIP_KEY) === '1'; } catch (e) { return false; } };
  const setSkip = (v) => { try { v ? localStorage.setItem(SKIP_KEY, '1') : localStorage.removeItem(SKIP_KEY); } catch (e) {} };

  // ── conteúdo (texto enxuto e profissional) ────────────────────────
  const step = (title, body) =>
    '<li class="hm-step"><span class="hm-n"></span>' +
    '<div class="hm-tx"><h4>' + title + '</h4><p>' + body + '</p></div></li>';

  function stepsHtml() {
    const s = [];
    s.push(step('O que é',
      'Transforma o Excel exportado do Gerenciador de Anúncios da Meta em um relatório pronto para apresentar. ' +
      'Sem planilha em mãos? Use <b>Dados de exemplo</b> no menu ☰.'));

    s.push(step('Configurações',
      'Em <b>☰ → Configurações</b> você ajusta o relatório: oculta e reordena seções, define o <b>Top 5</b> de anúncios, ' +
      'edita nomes e informa o <b>alcance real</b> da conta.'));

    s.push(step('Juntar dois conjuntos em um',
      'Conjuntos com os mesmos anúncios e públicos diferentes? Em <b>Configurações</b>, marque os dois e clique em ' +
      '<b>Mesclar marcados</b> — eles passam a contar como um só.'));

    s.push(step('Inserir e ajustar imagens',
      'Clique no espaço da imagem de um anúncio e envie de três formas: <b>arrastar</b>, <b>Selecionar arquivo</b> ou ' +
      '<b>colar com Ctrl + V</b>. Depois, use <b>Ajustar enquadramento</b> para reposicionar e dar zoom.'));

    s.push(step('Imagens em lote (automático)',
      'Em <b>☰ → Imagens dos criativos</b>, selecione vários arquivos de uma vez: cada imagem é associada ' +
      'automaticamente pelo <b>nome do anúncio</b>.'));

    if (VARIANT === 'v2') {
      s.push(step('Foto e zoom',
        'Defina a <b>foto do profissional</b> no menu (ou clicando sobre a foto) — ela aparece na capa e nos cabeçalhos. ' +
        'O relatório abre em <b>200%</b>; ajuste no canto inferior direito e arraste a página para navegar.'));
    } else {
      s.push(step('Navegação',
        'Use a barra no canto inferior direito para <b>aproximar</b> e <b>trocar de página</b>, ' +
        'ou a aba <b>❮ Páginas</b> na lateral esquerda.'));
    }

    s.push(step('Exportar em PDF',
      'Tudo pronto? <b>☰ → Exportar PDF</b> gera o arquivo com uma página por slide, pronto para enviar.'));

    return s.join('');
  }

  // ── estilo (alinhado ao #export-help; usa as variáveis do relatório) ─
  function injectCss() {
    if (document.getElementById('hm-style')) return;
    const css =
      '#hm-overlay{position:fixed;inset:0;z-index:100061;display:none;align-items:center;justify-content:center;' +
      'padding:24px;font-family:var(--font,system-ui,sans-serif)}' +
      '#hm-overlay.open{display:flex}' +
      '#hm-overlay .hm-bd{position:absolute;inset:0;background:rgba(6,6,6,.82)}' +
      '.hm-card{position:relative;width:min(600px,100%);max-height:88vh;overflow:auto;background:#121212;' +
      'border:1px solid var(--line,rgba(92,225,230,.55));border-radius:18px;padding:30px 34px 22px;' +
      'color:var(--ink,#fff);box-shadow:0 24px 80px rgba(0,0,0,.6)}' +
      '.hm-card::-webkit-scrollbar{width:10px}.hm-card::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:8px}' +
      '.hm-x{position:absolute;top:15px;right:17px;width:34px;height:34px;border-radius:50%;border:0;' +
      'background:rgba(255,255,255,.08);color:var(--ink,#fff);font-size:21px;line-height:1;cursor:pointer}' +
      '.hm-x:hover{background:rgba(255,255,255,.16)}' +
      '.hm-eyebrow{color:var(--accent,#5ce1e6);letter-spacing:.28em;font-weight:700;font-size:12px;text-transform:uppercase;margin-bottom:9px}' +
      '.hm-card h2{font-size:25px;font-weight:800;margin:0 0 8px;line-height:1.15;color:var(--ink,#fff)}' +
      '.hm-lead{font-size:14.5px;color:var(--ink-soft,#d8d8d8);line-height:1.5;margin:0 0 18px}' +
      '.hm-steps{list-style:none;margin:0;padding:0;counter-reset:hm}' +
      '.hm-step{display:flex;gap:14px;padding:13px 0;border-bottom:1px solid rgba(255,255,255,.07)}' +
      '.hm-step:last-child{border-bottom:0}' +
      '.hm-n{counter-increment:hm;flex:none;width:26px;height:26px;border-radius:50%;background:var(--accent,#5ce1e6);' +
      'color:#000;font-weight:800;font-size:13px;display:flex;align-items:center;justify-content:center}' +
      '.hm-n::before{content:counter(hm)}' +
      '.hm-tx{min-width:0}' +
      '.hm-tx h4{margin:0 0 3px;font-size:15px;font-weight:800;color:var(--ink,#fff);line-height:1.2}' +
      '.hm-tx p{margin:0;font-size:13.5px;line-height:1.5;color:var(--ink-soft,#d8d8d8)}' +
      '.hm-tx p b{color:var(--ink,#fff);font-weight:700}' +
      '.hm-foot{position:sticky;bottom:-22px;margin:18px -34px -22px;padding:15px 34px 18px;background:#121212;' +
      'border-top:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}' +
      '.hm-skip{display:flex;align-items:center;gap:9px;font-size:13.5px;color:var(--ink-soft,#d8d8d8);cursor:pointer;user-select:none}' +
      '.hm-skip input{width:16px;height:16px;cursor:pointer;accent-color:var(--accent,#5ce1e6)}' +
      '.hm-ok{background:var(--accent,#5ce1e6);color:#000;border:0;border-radius:10px;padding:11px 26px;' +
      'font-family:inherit;font-size:14px;font-weight:800;cursor:pointer}' +
      '.hm-ok:hover{filter:brightness(1.08)}';
    const st = document.createElement('style');
    st.id = 'hm-style'; st.textContent = css;
    document.head.appendChild(st);
  }

  // ── construção do overlay (uma vez) ───────────────────────────────
  let overlay = null;
  function build() {
    if (overlay) return overlay;
    injectCss();
    overlay = document.createElement('div');
    overlay.id = 'hm-overlay';
    overlay.className = 'export-hidden';
    overlay.innerHTML =
      '<div class="hm-bd"></div>' +
      '<div class="hm-card" role="dialog" aria-modal="true" aria-label="Guia rápido">' +
        '<button class="hm-x" type="button" title="Fechar" aria-label="Fechar">×</button>' +
        '<div class="hm-eyebrow">Guia rápido</div>' +
        '<h2>Bem-vindo ao gerador de relatórios</h2>' +
        '<p class="hm-lead">Em poucos passos você monta e exporta o relatório de Meta Ads. Veja o essencial:</p>' +
        '<ul class="hm-steps">' + stepsHtml() + '</ul>' +
        '<div class="hm-foot">' +
          '<label class="hm-skip"><input type="checkbox" id="hm-skip"> Não mostrar novamente</label>' +
          '<button class="hm-ok" type="button" id="hm-ok">Entendi!</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.querySelector('.hm-x').addEventListener('click', () => close());
    overlay.querySelector('#hm-ok').addEventListener('click', () => close());
    overlay.querySelector('.hm-bd').addEventListener('click', () => close());
    // marcar a caixinha fecha na hora e grava a preferência
    const skipBox = overlay.querySelector('#hm-skip');
    skipBox.addEventListener('change', () => { setSkip(skipBox.checked); if (skipBox.checked) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });
    return overlay;
  }

  function open() {
    build();
    const box = overlay.querySelector('#hm-skip'); if (box) box.checked = skipped();
    overlay.querySelector('.hm-card').scrollTop = 0;
    overlay.classList.add('open');
  }
  function close() { if (overlay) overlay.classList.remove('open'); }

  // Abre só se o usuário não pediu para pular (usado na entrada do relatório).
  let autoDone = false;
  function maybeAutoOpen() {
    if (autoDone || skipped()) return;
    autoDone = true;
    setTimeout(open, 350); // deixa o relatório aparecer antes
  }

  // ── gatilhos ──────────────────────────────────────────────────────
  function wire() {
    const btn = document.getElementById('rt-help');
    if (btn && !btn.__wired) { btn.__wired = true; btn.addEventListener('click', open); }

    // Auto-abrir quando a tela inicial some (entrou no relatório).
    const ss = document.getElementById('start-screen');
    if (ss) {
      const check = () => { if (ss.classList.contains('hidden') || ss.hidden || getComputedStyle(ss).display === 'none') maybeAutoOpen(); };
      check(); // caso já esteja escondida ao carregar
      new MutationObserver(check).observe(ss, { attributes: true, attributeFilter: ['class', 'hidden', 'style'] });
    } else {
      maybeAutoOpen();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.HelpModal = { open: open, close: close, maybeAutoOpen: maybeAutoOpen };
})();
