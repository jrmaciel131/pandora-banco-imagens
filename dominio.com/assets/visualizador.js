/* Exportador do visualizador: gera um documento imprimível (salvar como PDF)
   com a grade de todos os casos em uso pelos profissionais filtrados. Usado
   para apresentar ao cliente os casos disponibilizados a ele — por exemplo,
   no encerramento de contrato, quando os casos precisam ser retirados.

   Cada caso entra com TODAS as versões existentes (V1, V2, V3...), e por
   versão é escolhida uma única imagem, preferindo o formato VNI/QNI puro,
   depois VNI/QNI-NA, depois qualquer variante NA. */

function exportVisualizadorPDF(){
  const nomes = [...selProfs];
  const digitado = (selProf || '').trim();
  if(!nomes.length && digitado) nomes.push(digitado);
  if(!nomes.length){ showToast('Selecione ao menos um profissional no filtro.'); return; }

  const qs = nomes.map(norm);
  const lista = casos.filter(c => c.clientes.some(p => { const pn = norm(p); return qs.some(q => pn.includes(q)); }));
  if(!lista.length){ showToast('Nenhum caso em uso por ' + nomes.join(', ') + '.'); return; }

  /* Confirmação com a contagem — o export baixa uma imagem por caso (por
     profissional filtrado) e pode ser demorado; o usuário decide antes. */
  showConfirm(
    'Exportar PDF dos casos',
    `Gerar o PDF com <b>${lista.length}</b> caso(s) de <b>${esc(nomes.join(', '))}</b>?`,
    [{label: 'Profissional(is)', val: nomes.join(', ')}, {label: 'Casos', val: String(lista.length)}],
    () => { runExportVisualizadorPDF(nomes, lista); }
  );
}

async function runExportVisualizadorPDF(nomes, lista){
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:var(--sf);border-radius:var(--r);padding:1.75rem 2.25rem;text-align:center;min-width:260px">
    <span class="spin" style="width:26px;height:26px;border-width:3px"></span>
    <div style="margin-top:.75rem;font-size:14px;font-weight:600">Montando visualizador...</div>
    <div id="expv-prog" style="margin-top:.35rem;font-size:12px;color:var(--tx2)">0/${lista.length} casos</div>
  </div>`;
  document.body.appendChild(overlay);

  /* Busca as fotos de cada caso com concorrência limitada, no mesmo padrão
     do lazy-load da grade, pra não saturar o servidor. */
  const itens = [];
  const falhas = [];
  let done = 0;
  const fila = [...lista];
  const worker = async () => {
    while(fila.length){
      const c = fila.shift();
      try{
        const r = await api(`photos&id=${encodeURIComponent(c.id)}`);
        const sel = pickVisualizadorPhotos(r.photos || []);
        if(!sel.length) falhas.push(c.id);
        sel.forEach(s => itens.push({casoId: c.id, ver: s.ver, url: s.url}));
      } catch(e){ falhas.push(c.id); }
      done++;
      const p = document.getElementById('expv-prog');
      if(p) p.textContent = `${done}/${lista.length} casos`;
    }
  };
  await Promise.all(Array(Math.min(4, fila.length)).fill(0).map(worker));
  document.body.removeChild(overlay);

  if(!itens.length){ showToast('Nenhuma imagem encontrada para os casos filtrados.'); return; }
  abrirJanelaVisualizador(nomes, lista.length, itens, falhas);
}

/* Escolhe, por versão do caso, a melhor imagem para o visualizador.
   Prioridade: VNI/QNI puro (0), VNI/QNI-NA (1), qualquer NA (2); sem nenhum
   desses formatos, cai na primeira imagem disponível pra não deixar o caso
   sem representação na grade. Vídeos ficam de fora. */
function pickVisualizadorPhotos(photos){
  const imgs = photos.filter(p => !p.isVideo && (p.preview_url || p.thumb_url));
  if(!imgs.length) return [];
  const score = p => {
    const n = (p.name || '').toUpperCase();
    const fmt = /[-_ ](VNI|QNI)(?=[-_ .]|$)/.test(n);
    const na  = /[-_ ]NA(?=[-_ .]|$)/.test(n);
    if(fmt && !na) return 0;
    if(fmt && na)  return 1;
    if(na)         return 2;
    return 9;
  };
  const groups = {};
  imgs.forEach(p => {
    const ver = p.version || 'V1';
    (groups[ver] = groups[ver] || []).push(p);
  });
  return Object.keys(groups).sort().map(ver => {
    const best = [...groups[ver]].sort((a, b) => score(a) - score(b))[0];
    return {ver, url: new URL(best.preview_url || best.thumb_url, location.href).href};
  });
}

/* Abre a janela de impressão com a grade pronta. O usuário salva como PDF
   pelo diálogo do navegador (destino "Salvar como PDF"). */
function abrirJanelaVisualizador(nomes, totalCasos, itens, falhas){
  const w = window.open('', '_blank');
  if(!w){ showToast('Pop-up bloqueado — libere pop-ups deste site para gerar o PDF.'); return; }
  const hoje = new Date().toLocaleDateString('pt-BR');
  const cards = itens.map(it => `
    <figure class="card">
      <img src="${esc(it.url)}" alt="${esc(it.casoId)}">
      <figcaption>${esc(it.casoId)}${it.ver && it.ver !== 'V1' ? ' · ' + esc(it.ver) : ''}</figcaption>
    </figure>`).join('');
  const avisos = falhas.length
    ? `<p class="warn">⚠ Casos sem imagem disponível (não incluídos na grade): ${esc(falhas.join(', '))}</p>`
    : '';
  w.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Casos — ${esc(nomes.join(' + '))}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; padding: 24px; }
  header { margin-bottom: 16px; border-bottom: 2px solid #1a1a1a; padding-bottom: 10px; }
  header h1 { font-size: 20px; }
  header p { font-size: 12px; color: #555; margin-top: 4px; }
  .toolbar { margin: 14px 0; }
  .toolbar button { padding: 8px 18px; font-size: 13px; cursor: pointer; }
  .warn { font-size: 11px; color: #b45309; margin: 10px 0; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .card { break-inside: avoid; page-break-inside: avoid; border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
  .card img { width: 100%; aspect-ratio: 4/5; object-fit: cover; display: block; background: #f2f2f2; }
  .card figcaption { font-size: 10px; font-weight: 600; text-align: center; padding: 4px 2px; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
  @page { size: A4 portrait; margin: 12mm; }
</style></head><body>
<header>
  <h1>Casos disponibilizados — ${esc(nomes.join(' + '))}</h1>
  <p>${totalCasos} caso(s) · ${itens.length} imagem(ns) · gerado em ${hoje}</p>
</header>
<div class="toolbar"><button onclick="window.print()">🖨 Imprimir / Salvar como PDF</button></div>
${avisos}
<div class="grid">${cards}</div>
<script>
  window.addEventListener('load', () => {
    const imgs = [...document.images];
    Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; })))
      .then(() => setTimeout(() => window.print(), 300));
  });
<\/script>
</body></html>`);
  w.document.close();
}
