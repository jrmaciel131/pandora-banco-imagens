/* Tema (light/dark/auto), FAB de métricas, ajuda e tour guiado. */

/* Aplica tema salvo antes do DOMContentLoaded para evitar flash de cor errada. */
(function(){
  const saved = localStorage.getItem('bi_theme') || 'auto';
  if(saved !== 'auto') document.documentElement.setAttribute('data-theme', saved);
})();

function setTheme(theme){
  if(theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('bi_theme', theme);
  updateThemeButtons();
  const menu = document.getElementById('fab-menu');
  if(menu) menu.style.display = 'none';
}

function updateThemeButtons(){
  const saved = localStorage.getItem('bi_theme') || 'auto';
  ['auto','light','dark'].forEach(t => {
    const b = document.getElementById('theme-'+t);
    if(b){
      const active = t === saved;
      b.style.fontWeight   = active ? '700' : '';
      b.style.background   = active ? 'var(--accent)' : '';
      b.style.color        = active ? '#fff' : '';
      b.style.borderRadius = active ? 'var(--rs)' : '';
    }
  });
}

/* FAB de métricas — só aparece para admin com "métricas visuais" ativadas. */
function initFAB(){
  if(document.getElementById('metrics-fab')) return;

  const fab = document.createElement('button');
  fab.id = 'metrics-fab';
  fab.setAttribute('aria-label', 'Admin Mode');
  fab.style.cssText = 'position:fixed;bottom:1.5rem;right:1.5rem;width:48px;height:48px;border-radius:50%;background:var(--accent);color:#fff;border:none;display:none;align-items:center;justify-content:center;cursor:pointer;box-shadow:var(--shadow-lg);z-index:400;font-size:20px;transition:transform .2s,box-shadow .2s';
  fab.title = 'Admin Mode';
  fab.textContent = '⚡';
  fab.onclick = () => {
    const menu = document.getElementById('fab-menu');
    if(menu) menu.style.display = menu.style.display === 'flex' ? 'none' : 'flex';
  };
  fab.onmouseenter = () => { fab.style.transform = 'scale(1.1)'; fab.style.boxShadow = '0 8px 24px rgba(37,99,235,.5)'; };
  fab.onmouseleave = () => { fab.style.transform = ''; fab.style.boxShadow = ''; };

  const menu = document.createElement('div');
  menu.id = 'fab-menu';
  menu.style.cssText = 'position:fixed;bottom:5.5rem;right:1.5rem;background:var(--sf);border:1px solid var(--bds);border-radius:var(--r);padding:.5rem;display:none;flex-direction:column;gap:3px;z-index:401;box-shadow:var(--shadow-md);min-width:190px';
  menu.innerHTML = `
    <div style="font-size:10px;color:var(--tx3);padding:3px 8px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Métricas</div>
    <button class="btn bs" style="justify-content:flex-start;font-size:12px;padding:6px 10px" id="fab-metrics-btn" onclick="toggleGodModeVisual()">👁 Ativar métricas visuais</button>
    <div style="border-top:1px solid var(--bd);margin:3px 0"></div>
    <div style="font-size:10px;color:var(--tx3);padding:3px 8px;font-weight:700;text-transform:uppercase;letter-spacing:.06em">Tema</div>
    <button id="theme-auto"  class="btn bs" style="justify-content:flex-start;font-size:12px;padding:6px 10px" onclick="setTheme('auto')">🖥 Auto (sistema)</button>
    <button id="theme-light" class="btn bs" style="justify-content:flex-start;font-size:12px;padding:6px 10px" onclick="setTheme('light')">☀️ Claro</button>
    <button id="theme-dark"  class="btn bs" style="justify-content:flex-start;font-size:12px;padding:6px 10px" onclick="setTheme('dark')">🌙 Escuro</button>
  `;
  document.body.appendChild(fab);
  document.body.appendChild(menu);

  document.addEventListener('click', e => {
    if(!e.target.closest('#metrics-fab') && !e.target.closest('#fab-menu')) menu.style.display = 'none';
  });

  updateThemeButtons();
}

function openHelp(){ window.open('ajuda.html', '_blank'); }

const TOUR_STEPS = [
  {emoji:'👋', title:'Bem-vindo(a) ao Banco de Imagens!', text:'Este tour rápido (6 passos) mostra o essencial para você começar. Pode pular a qualquer momento.'},
  {emoji:'🧪', title:'Você está em modo teste',         text:'Tudo o que fizer aqui é sandbox — não afeta dados reais. Pode clicar, errar e refazer à vontade. Quando estiver à vontade, peça ao admin para liberar a produção.'},
  {emoji:'🔎', title:'Filtros',                          text:'Use Estado / Cidade / Profissional no topo para encontrar casos. O filtro "Exibir" começa em "Disponíveis" — quando você digita um nome no campo Profissional, ele troca automaticamente para "Em uso".'},
  {emoji:'🃏', title:'Os cards',                         text:'Cada card é um caso (CASO-001, etc.). Clique em um para ver fotos, registrar uso, ver o histórico do caso, e muito mais.'},
  {emoji:'📋', title:'Histórico',                        text:'Botão Histórico no topo mostra tudo que você ou outras pessoas alteraram. Filtra por usuário, caso ou texto livre.'},
  {emoji:'📚', title:'Precisa de ajuda?',                text:'Clique em Mais ▾ → "Ajuda & tutoriais" para abrir o guia completo a qualquer momento. Boa exploração!'},
];

function startTour(autoFromFirstLogin = false){
  closeMoreMenu();
  let i = 0;
  const ov = document.createElement('div');
  ov.id = 'tour-ov';
  ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9990;display:flex;align-items:center;justify-content:center;padding:1rem;backdrop-filter:blur(2px)';

  function render(){
    const s = TOUR_STEPS[i];
    ov.innerHTML = `
      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);max-width:460px;width:100%;padding:2rem 2rem 1.5rem;box-shadow:var(--shadow-lg);text-align:center;position:relative">
        <button onclick="endTour()" style="position:absolute;top:8px;right:10px;background:transparent;border:0;color:var(--tx3);font-size:22px;cursor:pointer;line-height:1">×</button>
        <div style="font-size:48px;margin-bottom:.5rem">${s.emoji}</div>
        <h3 style="font-size:18px;font-weight:700;margin-bottom:.5rem">${esc(s.title)}</h3>
        <p style="color:var(--tx2);font-size:14px;line-height:1.55;margin-bottom:1.25rem">${esc(s.text)}</p>
        <div style="display:flex;gap:6px;justify-content:center;margin-bottom:1.25rem">
          ${TOUR_STEPS.map((_,k)=>`<div style="width:8px;height:8px;border-radius:50%;background:${k===i?'var(--accent)':'var(--bd)'}"></div>`).join('')}
        </div>
        <div style="display:flex;gap:8px;justify-content:center">
          ${i > 0 ? '<button class="btn bs" onclick="tourPrev()">← Voltar</button>' : '<button class="btn bs" onclick="endTour()">Pular</button>'}
          ${i < TOUR_STEPS.length - 1
            ? '<button class="btn bp" onclick="tourNext()">Próximo →</button>'
            : '<button class="btn bp" onclick="endTour(true)">Concluir ✓</button>'}
        </div>
        <div style="margin-top:1rem;font-size:11px;color:var(--tx3)">${i+1} de ${TOUR_STEPS.length}</div>
      </div>`;
  }

  window.tourNext = () => { if(i < TOUR_STEPS.length - 1){ i++; render(); } };
  window.tourPrev = () => { if(i > 0){ i--; render(); } };
  window.endTour = done => { try { if(done) localStorage.setItem('bi_tour_seen', '1'); } catch(e){} ov.remove(); };

  document.body.appendChild(ov);
  render();
  if(!autoFromFirstLogin){ try { localStorage.setItem('bi_tour_seen', '1'); } catch(e){} }
}
