/* Bootstrap da aplicação: inicializa filtros, carrega casos e verifica sessão.
   Carregado por último — todos os globais definidos pelos outros módulos
   precisam estar disponíveis antes deste arquivo rodar. */

async function initApp(preloadedCasos = null, preloadedProfs = null){
  populateEstados();
  loadCanonicalTags();
  if(preloadedCasos){
    /* Switch_base já trouxe os dados na própria resposta — evita request extra. */
    casos = preloadedCasos;
    allProfs = preloadedProfs || [];
    applyFilter();
    checkNewFiles();
  } else {
    await loadCasos();
    checkNewFiles();
  }
}

checkSessionOnLoad();
