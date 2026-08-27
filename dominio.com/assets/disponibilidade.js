/* Exportador de disponibilidade por praça: gera um documento imprimível
   (salvar como PDF) com os casos de um profissional separados entre os que
   estão livres na praça filtrada e os que não podem ser usados nela. Usado
   quando um cliente vai passar a atuar em outro estado/cidade e precisa saber
   quais dos casos dele pode levar para lá.

   "Indisponível" junta dois motivos que o cliente não precisa distinguir: já
   existe uso registrado na praça, ou o caso está bloqueado (e aí não serve em
   praça nenhuma). O documento não diz qual dos dois é.

   O recorte é o mesmo da grade em modo combinado (`filterScope()`): o universo
   são apenas os casos do profissional e o status vem do uso na praça — por
   qualquer profissional. O documento é deliberadamente cego ao resto: não sai
   nome de quem usa, nem as cidades dos usos, nem estado algum além da praça
   consultada, nem motivo de bloqueio.

   Atenção ao classificar por cidade: o status é apenas "existe uso registrado
   nesta cidade", sem a regra de raio mínimo (`DISTANCE_RADIUS_KM`). Um caso em
   uso numa cidade vizinha aparece como livre aqui e ainda assim é barrado no
   registro. Por estado não há essa lacuna.

   Cada caso entra com TODAS as versões existentes (V1, V2, V3...), e por versão
   é escolhida uma única imagem, preferindo a variante NA (logo neutra, que não
   carrega a marca de nenhum cliente); sem NA, cai em VNI, QNI, QOI, nessa
   ordem, e por fim em qualquer imagem disponível.

   A qualidade é escolhida na hora de gerar. Em alta (padrão) as imagens saem da
   rendição ~1600px de `view_preview`, materializada sob demanda no servidor; em
   rápida, das miniaturas já cacheadas — bem mais leves, mas boas só para
   conferir a lista. */

const DISP_FORMATOS = ['VNI', 'QNI', 'QOI'];
/* Sufixos de logo de um cliente específico. Uma imagem assim identifica o
   profissional que a encomendou, então ela é o último recurso — e quando entra,
   o usuário é avisado antes de enviar o documento. */
const DISP_LOGOS_CLIENTE = ['LH', 'EH', 'CL'];

let _dispGrupos = null;

function exportDisponibilidadePDF(){
  const nomes = [...selProfs];
  const digitado = (selProf || '').trim();
  if(!nomes.length && digitado) nomes.push(digitado);
  if(!nomes.length){ showToast('Selecione ao menos um profissional no filtro.'); return; }
  if(!selUF){ showToast('Selecione o estado da praça no filtro.'); return; }

  const qs = nomes.map(norm);
  const local = selCity ? cap(selCity) : selUF;
  const doProf = casos.filter(c => matchesProfFilter(c, qs));
  if(!doProf.length){ showToast('Nenhum caso de ' + nomes.join(', ') + '.'); return; }

  /* Mesma leitura de praça da grade: com cidade selecionada o status é o uso
     naquela cidade; sem ela, o uso em qualquer cidade do estado.

     O bloqueio, porém, tem precedência sobre a praça: um caso bloqueado não
     está disponível em lugar nenhum, então vai para a lista de indisponíveis
     mesmo sem uso registrado aqui. Com isso a classificação é exaustiva — todo
     caso do profissional cai em exatamente uma das duas listas, e nenhum some
     do documento sem explicação. */
  const naPraca = c => selCity ? c.cidades.includes(selCity) : c.ufs.includes(selUF);
  _dispGrupos = {
    nomes,
    local,
    livres:     doProf.filter(c => !c.bloqueado && !naPraca(c)),
    emUso:      doProf.filter(c =>  c.bloqueado ||  naPraca(c)),
    bloqueados: doProf.filter(c =>  c.bloqueado).length
  };

  abrirModalDisponibilidade();
}

function abrirModalDisponibilidade(){
  const g = _dispGrupos;
  const set = (id, txt) => { const el = document.getElementById(id); if(el) el.textContent = txt; };
  set('disp-info', `Casos de ${g.nomes.join(', ')}, classificados pelo uso em ${g.local}.`);
  set('disp-livres-l', `Livres em ${g.local} (${g.livres.length})`);
  set('disp-uso-l', `Indisponíveis em ${g.local} (${g.emUso.length})`);
  set('disp-err', '');

  /* Quantos dos indisponíveis são bloqueio e não uso na praça. O documento não
     faz essa distinção — para o cliente os dois casos são "não dá" —, mas quem
     gera precisa saber do que o número é feito. */
  set('disp-nota', g.bloqueados
    ? `${g.bloqueados} caso(s) entram em "Indisponíveis" por bloqueio, não por uso em ${g.local}.`
    : '');

  /* A qualidade volta para "alta" a cada abertura: o erro caro aqui é mandar
     miniatura para o cliente, não esperar alguns segundos a mais. */
  const qAlta = document.getElementById('disp-q-alta');
  if(qAlta) qAlta.checked = true;

  /* Lista vazia entra desmarcada e desabilitada — marcada, sugeriria conteúdo
     que o documento não teria. */
  const livres = document.getElementById('disp-livres');
  const uso    = document.getElementById('disp-uso');
  if(livres){ livres.checked = g.livres.length > 0; livres.disabled = !g.livres.length; }
  if(uso){    uso.checked    = g.emUso.length  > 0; uso.disabled    = !g.emUso.length; }

  document.getElementById('dispv').classList.add('open');
}

async function submitDisponibilidadePDF(){
  const g = _dispGrupos;
  if(!g) return;
  const err = document.getElementById('disp-err');
  const querLivres = document.getElementById('disp-livres')?.checked && g.livres.length;
  const querUso    = document.getElementById('disp-uso')?.checked    && g.emUso.length;
  if(!querLivres && !querUso){
    if(err) err.textContent = 'Selecione ao menos uma das listas.';
    return;
  }
  if(err) err.textContent = '';
  document.getElementById('dispv').classList.remove('open');

  const alta = !!document.getElementById('disp-q-alta')?.checked;

  const secoes = [];
  /* "Indisponíveis" cobre os dois motivos — uso na praça e bloqueio — sem
     distinguir qual é qual, que é informação interna. */
  if(querLivres) secoes.push({titulo: 'Livres em ' + g.local,        descricao: `Nenhum uso registrado em ${g.local}.`,  casos: g.livres});
  if(querUso)    secoes.push({titulo: 'Indisponíveis em ' + g.local, descricao: 'Não podem ser usados nesta praça.',     casos: g.emUso});

  const total = secoes.reduce((n, s) => n + s.casos.length, 0);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:800;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:var(--sf);border-radius:var(--r);padding:1.75rem 2.25rem;text-align:center;min-width:260px">
    <span class="spin" style="width:26px;height:26px;border-width:3px"></span>
    <div style="margin-top:.75rem;font-size:14px;font-weight:600" id="dispv-fase">Montando documento...</div>
    <div id="dispv-prog" style="margin-top:.35rem;font-size:12px;color:var(--tx2)">0/${total} casos</div>
  </div>`;
  document.body.appendChild(overlay);
  const fase = txt => { const el = document.getElementById('dispv-fase'); if(el) el.textContent = txt; };
  const prog = txt => { const el = document.getElementById('dispv-prog'); if(el) el.textContent = txt; };

  /* Busca as fotos com concorrência limitada, no mesmo padrão do lazy-load da
     grade, pra não saturar o servidor. */
  const falhas = [];
  const comMarca = [];
  let done = 0;
  const fila = [];
  secoes.forEach(s => { s.itens = []; s.casos.forEach(c => fila.push({sec: s, caso: c})); });
  const worker = async () => {
    while(fila.length){
      const {sec, caso} = fila.shift();
      try{
        const r = await api(`photos&id=${encodeURIComponent(caso.id)}`);
        const sel = pickDisponibilidadePhotos(r.photos || [], alta);
        if(!sel.length) falhas.push(caso.id);
        if(sel.some(s => s.comMarca)) comMarca.push(caso.id);
        sel.forEach(s => sec.itens.push({casoId: caso.id, ver: s.ver, url: dispImgUrl(s.foto, alta)}));
      } catch(e){ falhas.push(caso.id); }
      done++;
      prog(`${done}/${total} casos`);
    }
  };
  await Promise.all(Array(Math.min(4, fila.length)).fill(0).map(worker));

  secoes.forEach(s => s.itens.sort(_dispOrdenaItens));
  const comImagem = secoes.reduce((n, s) => n + s.itens.length, 0);
  if(!comImagem){
    document.body.removeChild(overlay);
    showToast('Nenhuma imagem encontrada para os casos selecionados.');
    return;
  }

  /* Em alta, cada URL ainda não materializada faz o servidor buscar a rendição
     no Drive. Aquecer aqui, com a mesma concorrência de 4, evita que a janela
     de impressão dispare todas de uma vez; quando ela abrir, as imagens já
     vêm do cache do navegador. */
  if(alta) await _dispAquecerImagens(secoes, fase, prog);
  document.body.removeChild(overlay);

  abrirJanelaDisponibilidade(g, secoes, falhas, comMarca, alta);
}

async function _dispAquecerImagens(secoes, fase, prog){
  const urls = [...new Set(secoes.flatMap(s => s.itens.map(i => i.url)))];
  fase('Baixando imagens em alta...');
  prog(`0/${urls.length} imagens`);
  let done = 0;
  const fila = [...urls];
  const worker = async () => {
    while(fila.length){
      const url = fila.shift();
      await new Promise(r => { const im = new Image(); im.onload = im.onerror = r; im.src = url; });
      done++;
      prog(`${done}/${urls.length} imagens`);
    }
  };
  await Promise.all(Array(Math.min(4, fila.length)).fill(0).map(worker));
}

/* URL da imagem no documento. Em alta usa a rendição ~1600px do visualizador
   (`previewSrc`, de bulk.js): quando o servidor já a materializou, o link é
   estático; senão a action `view_preview` gera e guarda em cache na primeira
   visita. Em rápida usa a miniatura que já está no cache local. */
function dispImgUrl(p, alta){
  const src = alta ? previewSrc(p) : (p.thumb_url || p.preview_url);
  return new URL(src, location.href).href;
}

/* Ordena por número do caso e, dentro dele, por versão — o documento sai na
   mesma ordem que o cliente usa para conferir a lista. */
function _dispOrdenaItens(a, b){
  const na = parseInt((a.casoId || '').replace(/\D/g, '')) || 0;
  const nb = parseInt((b.casoId || '').replace(/\D/g, '')) || 0;
  return na !== nb ? na - nb : String(a.ver).localeCompare(String(b.ver));
}

/* Escolhe, por versão do caso, a melhor imagem para o documento.
   A variante NA vem primeiro porque é a única com logo neutra. Sem NA, cai nos
   formatos sem logo (VNI, QNI, QOI, nessa ordem) e depois em qualquer imagem
   sem marca. As variantes com logo de cliente ficam por último, como recurso
   final para o caso não sumir do documento. Vídeos ficam de fora.

   Em alta basta o arquivo existir no Drive — a rendição é gerada sob demanda —,
   então também entram fotos que ainda não têm miniatura no cache local; em
   rápida, só o que já está cacheado. */
function pickDisponibilidadePhotos(photos, alta){
  const imgs = photos.filter(p => !p.isVideo && (alta ? p.id : (p.preview_url || p.thumb_url)));
  if(!imgs.length) return [];
  const groups = {};
  imgs.forEach(p => {
    const ver = p.version || 'V1';
    (groups[ver] = groups[ver] || []).push(p);
  });
  return Object.keys(groups).sort().map(ver => {
    const best = [...groups[ver]].sort((a, b) => dispScore(a.name) - dispScore(b.name))[0];
    return {ver, foto: best, comMarca: dispScore(best.name) >= 20};
  });
}

/* Menor pontuação vence. A dezena é o tipo de logo (NA 0, sem logo 1, logo de
   cliente 2); a unidade ordena os formatos entre si (VNI 0, QNI 1, QOI 2,
   demais 3). */
function dispScore(name){
  const n = (name || '').toUpperCase();
  const tem = tok => new RegExp(`[-_ ]${tok}(?=[-_ .]|$)`).test(n);
  let fmt = DISP_FORMATOS.findIndex(tem);
  if(fmt === -1) fmt = DISP_FORMATOS.length;
  const logo = tem('NA') ? 0 : (DISP_LOGOS_CLIENTE.some(tem) ? 2 : 1);
  return logo * 10 + fmt;
}

/* Abre a janela de impressão com o documento pronto. O usuário salva como PDF
   pelo diálogo do navegador (destino "Salvar como PDF").

   Os avisos operacionais (casos sem imagem, imagens com logo de cliente) ficam
   num bloco visível só na tela: quem gera precisa vê-los antes de enviar, mas
   eles não têm por que sair no documento que vai para o cliente. */
function abrirJanelaDisponibilidade(g, secoes, falhas, comMarca, alta){
  const w = window.open('', '_blank');
  if(!w){ showToast('Pop-up bloqueado — libere pop-ups deste site para gerar o PDF.'); return; }
  const hoje = new Date().toLocaleDateString('pt-BR');

  const blocos = secoes.filter(s => s.itens.length).map(s => {
    const casosNaSecao = new Set(s.itens.map(i => i.casoId)).size;
    const cards = s.itens.map(it => `
      <figure class="card">
        <img src="${esc(it.url)}" alt="${esc(it.casoId)}">
        <figcaption>${esc(it.casoId)}${it.ver && it.ver !== 'V1' ? ' · ' + esc(it.ver) : ''}</figcaption>
      </figure>`).join('');
    return `<section>
      <div class="sec-head">
        <h2>${esc(s.titulo)}<span>${casosNaSecao} caso(s)</span></h2>
        <p class="sub">${esc(s.descricao || '')}</p>
      </div>
      <div class="grid">${cards}</div>
    </section>`;
  }).join('');

  const avisos = [];
  if(falhas.length)
    avisos.push(`Fora do documento por não ter nenhuma imagem: ${esc([...new Set(falhas)].join(', '))}.`);
  if(comMarca.length)
    avisos.push(`Sem variante NA nem formato sem logo, entraram com a logo de um cliente — confira antes de enviar: ${esc([...new Set(comMarca)].join(', '))}.`);
  const blocoAvisos = avisos.length
    ? `<div class="avisos">${avisos.map(a => `<p>${a}</p>`).join('')}</div>`
    : '';

  w.document.write(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8">
<title>Disponibilidade em ${esc(g.local)} — ${esc(g.nomes.join(' + '))}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1a1a1a; padding: 24px; }
  header { margin-bottom: 20px; border-bottom: 1px solid #1a1a1a; padding-bottom: 10px; }
  header h1 { font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
  header p { font-size: 11px; color: #666; margin-top: 5px; }
  .toolbar { margin: 16px 0; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .toolbar button { padding: 8px 18px; font-size: 13px; cursor: pointer; }
  .toolbar .q { font-size: 11px; color: #666; }
  section { margin-bottom: 22px; }
  /* Cada lista começa numa página nova: rolando ou folheando, a passagem de
     "livres" para "indisponíveis" nunca chega despercebida numa grade. */
  section + section { break-before: page; page-break-before: always; margin-top: 46px; }
  .sec-head { break-after: avoid; page-break-after: avoid; margin-bottom: 12px; }
  section h2 { font-size: 15px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
               padding-bottom: 6px; border-bottom: 2px solid #1a1a1a;
               display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  section h2 span { font-size: 11px; font-weight: 400; text-transform: none; letter-spacing: 0; color: #666; white-space: nowrap; }
  .sub { font-size: 11px; color: #666; margin-top: 6px; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
  .card { break-inside: avoid; page-break-inside: avoid; border: 1px solid #e5e5e5; border-radius: 4px; overflow: hidden; }
  .card img { width: 100%; aspect-ratio: 4/5; object-fit: cover; display: block; background: #f2f2f2; }
  .card figcaption { font-size: 10px; font-weight: 600; text-align: center; padding: 4px 2px; }
  .avisos { border: 1px solid #f0d9a8; background: #fdf6e7; border-radius: 4px; padding: 9px 12px; margin-bottom: 18px; }
  .avisos p { font-size: 11px; color: #7a5b12; line-height: 1.5; }
  .avisos p + p { margin-top: 4px; }
  /* Na tela não existe quebra de página, então a divisa entre as listas
     precisa de um traço próprio. */
  @media screen { section + section { border-top: 1px dashed #bbb; padding-top: 34px; } }
  @media print { .toolbar, .avisos { display: none; } body { padding: 0; } }
  @page { size: A4 portrait; margin: 12mm; }
</style></head><body>
<header>
  <h1>Disponibilidade em ${esc(g.local)}</h1>
  <p>${esc(g.nomes.join(' + '))} · gerado em ${hoje}</p>
</header>
<div class="toolbar">
  <button onclick="window.print()">🖨 Imprimir / Salvar como PDF</button>
  <span class="q">${alta
    ? 'Imagens em alta (~1600px).'
    : 'Imagens em qualidade rápida — gere em alta antes de enviar ao cliente.'}</span>
</div>
${blocoAvisos}
${blocos}
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
