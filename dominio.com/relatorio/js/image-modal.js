/* ─────────────────────────────────────────────────────────────────
   image-modal.js — ao clicar num criativo, abre um modal com 3 formas de
   trocar a imagem: arrastar arquivo, selecionar arquivo, ou colar (Ctrl+V).
   O arquivo escolhido é entregue ao <image-slot> (que já persiste e
   sobrevive ao export), reutilizando o input interno do componente.
   ───────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  let currentSlot = null;

  const modal = document.createElement('div');
  modal.id = 'img-modal';
  modal.className = 'export-hidden';
  modal.innerHTML =
    '<div class="im-card">' +
      '<button class="im-close" title="Fechar">×</button>' +
      '<h3>Trocar imagem do criativo</h3>' +
      '<div class="im-drop" id="im-drop">Arraste uma imagem aqui<br><small>ou cole com <b>Ctrl+V</b></small></div>' +
      '<button class="im-pick" id="im-pick" type="button">Selecionar arquivo</button>' +
      '<button class="im-pick im-frame" id="im-frame" type="button" hidden>Ajustar enquadramento</button>' +
      '<input type="file" id="im-file" accept="image/*" hidden>' +
      '<div class="im-status" id="im-status"></div>' +
    '</div>';
  document.body.appendChild(modal);

  const drop = modal.querySelector('#im-drop');
  const status = modal.querySelector('#im-status');
  const fileInput = modal.querySelector('#im-file');
  const frameBtn = modal.querySelector('#im-frame');

  function open(slot) {
    currentSlot = slot; status.textContent = '';
    // "Ajustar enquadramento" só aparece quando o criativo já tem imagem.
    frameBtn.hidden = !(slot && slot.hasAttribute('data-filled'));
    modal.classList.add('open');
  }
  function close() { modal.classList.remove('open'); currentSlot = null; }

  // "Ajustar enquadramento": fecha o modal e entra no modo de reenquadrar do
  // <image-slot> (arrastar p/ posicionar, rolar p/ zoom) via duplo-clique sintético.
  frameBtn.addEventListener('click', () => {
    const s = currentSlot; close();
    if (s) s.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });

  // Entrega o arquivo ao <image-slot> reusando seu input interno (shadow DOM).
  function feedSlot(slot, file) {
    try {
      const input = slot.shadowRoot && slot.shadowRoot.querySelector('input[type="file"]');
      if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    } catch (e) { /* cai no fallback */ }
    // Fallback: simula um drop no slot.
    try {
      const dt = new DataTransfer();
      dt.items.add(file);
      slot.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      return true;
    } catch (e) { return false; }
  }

  function apply(file) {
    if (!file) return;
    if (!currentSlot) { return; }
    if (!file.type || file.type.indexOf('image/') !== 0) {
      status.textContent = 'O arquivo não é uma imagem.';
      return;
    }
    if (feedSlot(currentSlot, file)) close();
    else status.textContent = 'Não consegui aplicar a imagem neste slot.';
  }

  // Abre o modal ao clicar num <image-slot> (intercepta antes do browse padrão).
  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#img-modal')) return;
    const slot = e.target.closest && e.target.closest('image-slot');
    // Em modo de reenquadrar (data-reframe) os cliques/arrastos são do próprio
    // slot — não reabrir o modal por cima.
    if (slot && !slot.hasAttribute('data-reframe')) { e.preventDefault(); e.stopPropagation(); open(slot); }
  }, true);

  modal.querySelector('.im-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && modal.classList.contains('open')) close(); });

  modal.querySelector('#im-pick').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => apply(e.target.files[0]));

  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('hot'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault(); drop.classList.remove('hot');
    apply(e.dataTransfer && e.dataTransfer.files[0]);
  });

  // Exposto para o casamento automático de imagens por nome (report-render).
  window.__feedSlot = feedSlot;

  // Colar (Ctrl+V) com o modal aberto.
  document.addEventListener('paste', (e) => {
    if (!modal.classList.contains('open')) return;
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf('image/') === 0) { apply(it.getAsFile()); break; }
    }
  });
})();
