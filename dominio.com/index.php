<?php
/* Cache busting automático — gera ?v= baseado na data de modificação do arquivo.
   Sem tocar em nada: sempre que um .css ou .js é salvo no servidor, o hash muda
   automaticamente e o browser baixa a versão nova. */
function v($f){ $p = __DIR__.'/'.$f; return $f.'?v='.(file_exists($p) ? filemtime($p) : '0'); }

/* Lê o identificador de build embutido em assets/utils.js (a "fonte da verdade"
   no servidor). É injetado no HTML como window.APP_BUILD_EXPECTED; o utils.js
   que o navegador carregou compara com o seu próprio APP_BUILD e avisa quando
   uma versão em cache está sendo exibida. */
function jsBuild(){
  $p = __DIR__.'/assets/utils.js';
  if(!is_file($p)) return '';
  $head = (string)@file_get_contents($p, false, null, 0, 2000);
  return preg_match("/APP_BUILD\\s*=\\s*'([^']*)'/", $head, $m) ? $m[1] : '';
}

// Carrega a config privada apenas para expor a site key pública do Turnstile
// ao HTML de login. Ausência do arquivo não é fatal (mantém o login funcional).
$_cfgPath = __DIR__ . '/../private-config/config.php';
if (is_file($_cfgPath)) require_once $_cfgPath;
$TURNSTILE_SITE_KEY = defined('TURNSTILE_SITE_KEY') ? TURNSTILE_SITE_KEY : '';
?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Banco de Imagens</title>
<!-- Google Fonts (Inter + JetBrains Mono) — pré-conectar pra acelerar -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">

<link rel="stylesheet" href="<?php echo v('assets/theme.css'); ?>">
<link rel="stylesheet" href="<?php echo v('assets/app.css'); ?>">
<?php if ($TURNSTILE_SITE_KEY !== ''): ?>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<?php endif; ?>
</head>
<body>

<div id="session-loading">
  <div class="spin"></div>
  <div style="font-size:13px;color:var(--tx2)">Verificando sessão...</div>
</div>

<div id="ls">
  <div class="lcard">
    <h1>Banco de imagens</h1>
    <p>Faça login para continuar</p>
    <div class="field"><label>Usuário</label><input type="text" id="lu" autocomplete="username" placeholder="seu usuário"></div>
    <div class="field"><label>Senha</label>
      <div style="position:relative">
        <input type="password" id="lp" autocomplete="current-password" placeholder="••••••••" style="padding-right:44px">
        <button type="button" onclick="togglePwd()" id="lpbtn" style="position:absolute;right:1px;top:1px;bottom:1px;width:40px;background:transparent;border:none;cursor:pointer;color:var(--tx3);font-size:16px;display:flex;align-items:center;justify-content:center;border-radius:0 var(--rs) var(--rs) 0" title="Mostrar/ocultar senha">👁</button>
      </div>
    </div>
    <?php if ($TURNSTILE_SITE_KEY !== ''): ?>
    <div class="cf-turnstile" data-sitekey="<?php echo htmlspecialchars($TURNSTILE_SITE_KEY, ENT_QUOTES); ?>" data-theme="auto" style="margin-top:.75rem;display:flex;justify-content:center"></div>
    <?php endif; ?>
    <div class="err" id="le" style="display:none"></div>
    <button class="btn bp" id="lb2" onclick="doLogin()" style="width:100%;margin-top:.75rem;justify-content:center">Entrar</button>
  </div>
</div>

<div id="bs" style="display:none;position:fixed;inset:0;background:var(--bg);z-index:800;align-items:center;justify-content:center;padding:1rem">
  <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:2.25rem;width:100%;max-width:420px;box-shadow:var(--shadow-lg);text-align:center">
    <div style="font-size:32px;margin-bottom:.75rem">📂</div>
    <h2 style="font-size:20px;font-weight:700;margin-bottom:.35rem">Selecione a base</h2>
    <p style="font-size:13px;color:var(--tx2);margin-bottom:1.75rem">Escolha qual banco de imagens você quer acessar</p>
    <div id="base-buttons" style="display:flex;flex-direction:column;gap:10px"></div>
    <div style="margin-top:1rem;font-size:12px;color:var(--tx3)" id="bs-user"></div>
  </div>
</div>

<div id="as">

  <div class="topbar">
    <div class="tb-brand">Banco de imagens <span class="vbadge">v23</span> <span id="tb-base-badge" style="display:none;font-size:11px;font-weight:700;padding:2px 8px;border-radius:20px;background:var(--accent);color:#fff;margin-left:4px"></span></div>
    <div class="tb-spacer"></div>

    <div class="tb-user">
      <div class="tb-user-dot"></div>
      <span id="tu">—</span>
    </div>

    <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="showView('hist')">📋 Histórico</button>
    <button class="btn bs" id="btn-refresh" style="padding:6px 12px;font-size:12px" onclick="forceRefresh()" title="Força atualização ignorando o cache do servidor — use depois de adicionar casos novos no Sheets ou arquivos novos no Drive">🔄 Atualizar</button>
    <span id="page-load-timer" style="display:none;font-size:11px;color:var(--tx3);font-weight:600"></span>

    <div class="tb-more" id="tb-more">
      <button class="tb-more-btn" onclick="toggleMoreMenu()">Mais ▾</button>
      <div class="tb-dropdown" id="tb-dropdown">
        <div class="tb-drop-item" onclick="syncAll();closeMoreMenu()">🔄 Sincronizar</div>
        <div class="tb-drop-sep" data-admin style="display:none"></div>
        <div data-admin style="display:none;padding:4px 14px 2px;font-size:10px;color:var(--tx3);font-weight:700;text-transform:uppercase;letter-spacing:.05em">Administração</div>
        <div class="tb-drop-item" data-admin onclick="showView('admin');closeMoreMenu()" style="display:none">⚡ Admin Mode</div>
        <div class="tb-drop-sep"></div>
        <div style="padding:4px 14px 2px;font-size:10px;color:var(--tx3);font-weight:700;text-transform:uppercase;letter-spacing:.05em">Base de dados</div>
        <div id="base-menu-items"></div>
        <div class="tb-drop-sep"></div>
        <div style="padding:4px 14px 2px;font-size:10px;color:var(--tx3);font-weight:700;text-transform:uppercase;letter-spacing:.05em">Tema</div>
        <div class="tb-drop-item" id="theme-auto"  onclick="setTheme('auto');closeMoreMenu()">🖥 Auto (sistema)</div>
        <div class="tb-drop-item" id="theme-light" onclick="setTheme('light');closeMoreMenu()">☀️ Claro</div>
        <div class="tb-drop-item" id="theme-dark"  onclick="setTheme('dark');closeMoreMenu()">🌙 Escuro</div>
        <div class="tb-drop-sep"></div>
        <div class="tb-drop-item" onclick="openHelp();closeMoreMenu()">📚 Ajuda &amp; tutoriais</div>
        <div class="tb-drop-item" onclick="startTour();closeMoreMenu()">🎬 Tour guiado</div>
        <div class="tb-drop-item" onclick="window.open('../export/','_blank');closeMoreMenu()">📤 Exportar casos</div>
        <div class="tb-drop-sep"></div>
        <div class="tb-drop-item" onclick="doLogout()">← Sair</div>
      </div>
    </div>
  </div>

  <div id="swarn" style="display:none">
    <span style="flex:1">⏳ Sessão expira em <b id="swmin">15</b> min.</span>
    <button onclick="renewSession()">Renovar sessão</button>
    <button onclick="this.closest('#swarn').style.display='none'" style="background:transparent;color:#fff;border:1px solid rgba(255,255,255,.4)">Dispensar</button>
  </div>

  <div id="na" style="display:none">
    <span style="width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block"></span>
    <span id="nat"></span>
    <button class="btn bs" style="padding:3px 9px;font-size:11px;margin-left:auto" onclick="this.closest('#na').style.display='none'">Dispensar</button>
  </div>

  <div class="main">

    <div id="view-main" class="view active">
      <div id="s-sticky-stats" class="s-sticky-stats" style="display:none">
        <span class="s-ss-dot"></span>
        <b id="s-ss-disp">—</b><span> disponíveis</span>
        <span class="s-ss-sep"></span>
        <b id="s-ss-sel">0</b><span> selecionados</span>
        <span class="s-ss-sep"></span>
        <span id="s-ss-filters" class="s-ss-filters">—</span>
      </div>

      <div class="s-layout">

        <!-- Rail vertical de filtros -->
        <aside class="s-rail" id="filters-rail">
          <button class="s-rail-close" aria-label="Fechar filtros" onclick="document.getElementById('filters-rail').classList.remove('s-open')">×</button>

          <section class="s-rail-section">
            <h3>Estado</h3>
            <div class="fw">
              <select id="fuf" onchange="onUFChange()"><option value="">Todos os estados</option></select>
            </div>
          </section>

          <section class="s-rail-section" id="cw" style="display:none">
            <h3>Cidade</h3>
            <div class="fw">
              <div class="ddw">
                <input type="text" id="fci" placeholder="Pesquise a cidade..." oninput="onCityInput()" onfocus="openCityDD()" autocomplete="off">
                <div class="dd" id="cdd"></div>
              </div>
            </div>
          </section>

          <section class="s-rail-section">
            <h3>Profissional</h3>
            <div class="fw">
              <div class="ddw">
                <input type="text" id="fpro" placeholder="Nome do profissional..." oninput="onProfSearch()" onfocus="openProfDD()" autocomplete="off">
                <div class="dd" id="prodd"></div>
              </div>
            </div>
          </section>

          <section class="s-rail-section" style="display:none">
            <h3>Status</h3>
            <div class="fw">
              <select id="fshow" onchange="onShowFilterChange()">
                <option value="todos">Todos</option>
                <option value="disponivel" selected>Disponíveis</option>
                <option value="em_uso">Em uso</option>
                <option value="bloqueado">Bloqueados</option>
              </select>
            </div>
          </section>

          <section class="s-rail-section">
            <h3>Tags</h3>
            <div class="fw">
              <div class="ddw">
                <input type="text" id="ftag" placeholder="Adicione tags para filtrar..." oninput="onTagFilterInput()" onfocus="openTagFilterDD()" autocomplete="off">
                <div class="dd" id="ftagdd"></div>
              </div>
            </div>
            <div id="ftag-chips" style="display:flex;gap:5px;flex-wrap:wrap;margin-top:5px"></div>
          </section>

          <section class="s-rail-section">
            <h3>IDs específicos</h3>
            <div class="fw">
              <input type="text" id="fids" placeholder="244, 255, 834…" oninput="applyFilter()" autocomplete="off">
            </div>
          </section>

          <section class="s-rail-section s-rail-actions">
            <button class="btn bs" id="btn-clf" style="display:none" onclick="clearFilters()">✕ Limpar filtros</button>
          </section>
        </aside>

        <!-- Main content -->
        <main class="s-main">
          <div id="dp">
            <div class="dh" onclick="runDiag()">
              <div style="font-size:14px;font-weight:600">🔧 Diagnóstico de conexão</div>
              <span id="ds" style="font-size:12px;color:var(--tx2)">Clique para testar</span>
            </div>
            <div class="db" id="db" style="display:none"></div>
          </div>

          <div class="s-content-head">
            <div>
              <h1 class="s-page-title">Banco de imagens</h1>
            </div>
            <div style="flex:1"></div>
            <div class="s-density-toggle" id="s-density">
              <button data-density="comfort" title="Confortável">⊞</button>
              <button data-density="normal" class="active" title="Denso">▦</button>
              <button data-density="compact" title="Compacto">▤</button>
            </div>
            <div class="s-view-toggle" id="s-view-toggle">
              <button data-view="grid" class="active" title="Grid">▦</button>
              <button data-view="list" title="Lista">☰</button>
            </div>
            <button class="btn bs" id="btn-mobile-filters">Filtros</button>
            <div class="s-sel-group">
              <button class="btn bs" id="btn-sel" onclick="toggleSel()">Selecionar</button>
              <button class="btn bs" id="btn-selall" onclick="toggleSelAll()">Todos</button>
            </div>
          </div>

          <div id="s-quick-tabs" class="s-quick-tabs">
            <button class="s-qt-btn" data-preset="todos">Todos <span class="s-qt-count" id="qt-c-todos">—</span></button>
            <button class="s-qt-btn active" data-preset="disponivel">Disponíveis <span class="s-qt-count" id="qt-c-disp">—</span></button>
            <button class="s-qt-btn" data-preset="em_uso">Em uso <span class="s-qt-count" id="qt-c-uso">—</span></button>
            <button class="s-qt-btn" data-preset="bloqueado">Bloqueados <span class="s-qt-count" id="qt-c-bloq">—</span></button>
            <span class="s-qt-sep"></span>
            <button class="s-qt-btn" data-preset="recente">Recém-adicionados <span class="s-qt-count" id="qt-c-rec">—</span></button>
          </div>

          <div class="stats">
            <div class="stat"><div class="sn" id="st">—</div><div class="sl">Total</div></div>
            <div class="stat"><div class="sn" id="sd" style="color:var(--gtx)">—</div><div class="sl">Disponíveis</div></div>
            <div class="stat"><div class="sn" id="su" style="color:var(--rtx)">—</div><div class="sl">Em uso</div></div>
          </div>

          <div id="s-active-filters" class="s-active-filters" style="display:none">
            <span class="s-af-label">Filtros ativos</span>
            <div id="s-af-chips"></div>
            <button class="s-af-clear" onclick="clearFilters()">✕ Limpar tudo</button>
          </div>

          <div id="bb">
            <div style="font-size:13px;font-weight:600;flex:1" id="bc">0 selecionados</div>
            <button class="btn bp" style="padding:6px 13px;font-size:12px" onclick="openBulkApply()">Registrar uso nos selecionados</button>
            <button class="btn bs" style="padding:6px 13px;font-size:12px" onclick="openBulkTag()">🏷 Aplicar tag</button>
            <button class="btn bs" style="padding:6px 13px;font-size:12px" onclick="downloadBulkZip()" title="Até 30 casos por download">📦 Baixar (ZIP)</button>
            <button class="btn bs" style="padding:6px 13px;font-size:12px" onclick="clearSel()">Limpar seleção</button>
          </div>

          <div class="cg" id="grid"></div>
          <div class="empty" id="empty" style="display:none">Nenhum caso encontrado.</div>
          <div class="pager" id="pager"></div>
        </main>
      </div>
    </div>

    <div id="view-hist" class="view">
      <div class="hist-header">
        <h2>Histórico de alterações</h2>
        <select id="hfuser" onchange="loadHistorico()" style="padding:6px 10px;border:0.5px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none">
          <option value="">Todos os usuários</option>
        </select>
        <input type="text" id="hfcaso" placeholder="Caso (ex: 100)..." style="padding:6px 10px;border:0.5px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;width:140px" oninput="loadHistorico()">
        <input type="text" id="hfsearch" placeholder="Buscar UF, cidade, profissional..." style="padding:6px 10px;border:0.5px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;width:210px" oninput="loadHistorico()">
        <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="loadHistorico()">↻</button>
        <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="showView('main')">← Voltar</button>
      </div>
      <div id="hist-body" style="background:var(--sf);border:0.5px solid var(--bd);border-radius:var(--r);overflow:hidden">
        <div style="padding:2rem;text-align:center;color:var(--tx2)"><span class="spin"></span></div>
      </div>
    </div>

    <div id="view-admin" class="view">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:1.25rem;flex-wrap:wrap">
        <h2 style="font-size:18px;font-weight:700;flex:1">⚡ Admin Mode <span style="font-size:12px;font-weight:400;color:var(--tx2);margin-left:6px">Acesso restrito a administradores</span></h2>
        <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="showView('main')">← Voltar</button>
      </div>

      <!-- G: Audit dashboard always-on -->
      <div id="s-audit-dash" class="s-audit-dash" style="display:none;margin-bottom:1rem"></div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <div class="dh" onclick="runDiag('admin')">
          <div style="font-size:14px;font-weight:600">🔧 Diagnóstico de conexão</div>
          <span id="ds-admin" style="font-size:12px;color:var(--tx2)">Clique para testar</span>
        </div>
        <div class="db" id="db-admin" style="display:none"></div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">🧬 Diagnóstico de versão</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.75rem">Confere o que está no servidor (data, hash, build) contra o que o navegador carregou. Build do servidor diferente do carregado = versão em cache; hash diferente do esperado = arquivo antigo no servidor.</p>
        <div id="version-info"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:.6rem">
          <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="loadVersionInfo()">🔄 Atualizar</button>
          <button class="btn bs" style="padding:6px 12px;font-size:12px" onclick="diagnoseConfirmModal()">🩺 Testar modal</button>
        </div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.75rem">🛠 Ferramentas</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn bs" id="adminmode-toggle" style="padding:7px 14px;font-size:13px" onclick="toggleGodModeVisual()">👁 Ativar métricas visuais</button>
          <button class="btn bd-r" style="padding:7px 14px;font-size:13px" onclick="confirmClearAllCache()">🗑 Limpar cache global</button>
        </div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.75rem">⏱ Teste de velocidade de imagens</h3>
        <p style="font-size:13px;color:var(--tx2);margin-bottom:.75rem">Compare o tempo de carregamento via cache local vs. Google Drive direto.</p>
        <div style="display:flex;gap:8px;margin-bottom:.75rem;flex-wrap:wrap">
          <input type="text" id="speed-id" placeholder="ID do caso (ex: 244)" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;width:200px">
          <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="runSpeedTest()">Testar</button>
        </div>
        <div id="speed-result" style="display:none;background:var(--bg);border-radius:var(--rs);padding:.85rem 1rem;font-size:13px"></div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">👥 Gerenciar usuários</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Usuários novos começam em <b style="color:#92400e">🧪 Modo teste</b> — só veem a base sandbox para aprender o sistema.
          Quando estiverem prontos, clique em <b>"Promover p/ produção"</b> para liberar acesso às bases reais (PH e PO).
        </p>
        <!-- G: Bulk bar de usuários -->
        <div id="s-users-bulk-bar" class="s-users-bulk-bar" style="display:none">
          <span class="s-ub-count"></span>
          <button class="btn bp" style="padding:5px 12px;font-size:12px" onclick="bulkSetProdAccess(true)">Promover p/ produção</button>
          <button class="btn bs" style="padding:5px 12px;font-size:12px" onclick="bulkSetProdAccess(false)">Voltar p/ teste</button>
          <button class="btn bd-r" style="padding:5px 12px;font-size:12px" onclick="bulkRemoveUsers()">Remover</button>
          <button class="btn bs" style="padding:5px 12px;font-size:12px" onclick="_checkedUsers.clear();updateUserBulkBar();document.querySelectorAll('.s-user-cb').forEach(c=>c.checked=false)">Limpar</button>
        </div>
        <div id="users-list" style="margin-bottom:1rem"></div>
        <div style="background:var(--bg);border-radius:var(--rs);padding:1rem;border:1px solid var(--bd);margin-top:.75rem">
          <h4 style="font-size:13px;font-weight:600;margin-bottom:.75rem">➕ Adicionar usuário</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px">
            <input type="text" id="new-user" placeholder="Nome de usuário" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;flex:1;min-width:140px">
            <input type="text" id="new-pass" placeholder="Senha (ver requisitos)" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;flex:2;min-width:180px">
            <select id="new-role" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none">
              <option value="user">usuário</option>
              <option value="admin">admin</option>
            </select>
            <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="addUser()">Criar</button>
          </div>
          <div class="err" id="add-user-err"></div>
        </div>
        <div style="background:var(--bg);border-radius:var(--rs);padding:1rem;border:1px solid var(--bd);margin-top:.75rem">
          <h4 style="font-size:13px;font-weight:600;margin-bottom:.75rem">Alterar senha</h4>
          <p style="font-size:11px;color:var(--tx3);margin-bottom:.6rem">Requisitos: mín. 6 chars, maiúscula, minúscula, número e caractere especial.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <select id="pwd-user" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;flex:1;min-width:140px"></select>
            <input type="text" id="pwd-new" placeholder="Nova senha (mín. 6 chars)" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;flex:2;min-width:180px">
            <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="changePassword()">Alterar</button>
          </div>
          <div class="err" id="pwd-err" style="margin-top:.4rem"></div>
        </div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">🔍 Auditoria de dados</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Varre todos os casos em todas as bases procurando inconsistências: UFs inválidas, cidades não reconhecidas pelo CSV, cidades em UF errada e duplicatas. Use depois de mexer na planilha pra garantir que a validação de distância funciona corretamente.
        </p>
        <div style="display:flex;gap:8px;margin-bottom:.75rem">
          <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="runDataAudit()">Executar auditoria</button>
          <button class="btn bs" style="padding:7px 14px;font-size:13px;display:none" id="audit-export-btn" onclick="exportAuditReport()">Exportar (.txt)</button>
        </div>
        <div id="audit-result" style="display:none;font-size:12px"></div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">🔄 Sincronização Drive ↔ planilha</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Cruza os casos encontrados nos <b>nomes dos arquivos</b> do Drive com as linhas da planilha. Casos que estão no Drive mas faltam na planilha podem ter a linha criada automaticamente (só o ID). Casos na planilha sem nenhum arquivo são listados como pendentes de fotos.
        </p>
        <div style="display:flex;gap:8px;margin-bottom:.75rem">
          <button class="btn bp" style="padding:7px 14px;font-size:13px" id="sync-check-btn" onclick="runSyncPreview()">Verificar sincronização</button>
        </div>
        <div id="sync-result" style="display:none;font-size:12px"></div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">📏 Auditoria de distâncias</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Simula a regra de raio mínimo sobre os casos já existentes: varre todas as bases e aponta pares de cidades no mesmo caso que estão a uma distância em linha reta menor ou igual ao raio configurado.
        </p>
        <div style="background:var(--bg);border-radius:var(--rs);padding:.75rem 1rem;border:1px solid var(--bd);margin-bottom:.75rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <label style="font-size:12px;color:var(--tx2);font-weight:600">Raio mínimo (km):</label>
          <input type="number" id="dist-radius-input" min="1" max="5000" step="1" style="padding:6px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;width:90px">
          <button class="btn bp" style="padding:6px 12px;font-size:12px" onclick="saveDistanceConfig()">Salvar raio</button>
          <span id="dist-radius-msg" style="font-size:11px;color:var(--tx3)"></span>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:.75rem">
          <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="runDistanceAudit()">Executar auditoria de distâncias</button>
          <button class="btn bs" style="padding:7px 14px;font-size:13px;display:none" id="dist-audit-export-btn" onclick="exportDistanceAudit()">Exportar (.txt)</button>
        </div>
        <div id="dist-audit-result" style="display:none;font-size:12px"></div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">🃏 Cidades coringa (raio reduzido)</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Cidades muito populosas onde o raio mínimo é menor que o padrão. Ao comparar duas cidades vale sempre o <b>menor</b> raio entre as duas — então o raio reduzido do coringa prevalece em qualquer par de que ele participe. O padrão atual é <b id="coringa-default-km">—</b> km.
        </p>
        <div id="coringas-list" style="margin-bottom:1rem"></div>
        <div style="background:var(--bg);border-radius:var(--rs);padding:1rem;border:1px solid var(--bd)">
          <h4 style="font-size:13px;font-weight:600;margin-bottom:.75rem">➕ Adicionar coringa</h4>
          <p style="font-size:11px;color:var(--tx3);margin-bottom:.6rem">Escolha a UF, digite a cidade e selecione uma da lista (IBGE). Só cidades reconhecidas são aceitas.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
            <select id="coringa-uf" onchange="onCoringaUF()" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none">
              <option value="">UF</option>
              <option>AC</option><option>AL</option><option>AP</option><option>AM</option><option>BA</option>
              <option>CE</option><option>DF</option><option>ES</option><option>GO</option><option>MA</option>
              <option>MT</option><option>MS</option><option>MG</option><option>PA</option><option>PB</option>
              <option>PR</option><option>PE</option><option>PI</option><option>RJ</option><option>RN</option>
              <option>RS</option><option>RO</option><option>RR</option><option>SC</option><option>SP</option>
              <option>SE</option><option>TO</option>
            </select>
            <div class="ddw" style="flex:2;min-width:160px">
              <input type="text" id="coringa-cidade" placeholder="Selecione a UF primeiro..." readonly oninput="onCoringaCityInp()" onfocus="openCoringaCityDD()" autocomplete="off" data-val="" style="box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none">
              <div class="dd" id="coringa-cidade-dd"></div>
            </div>
            <input type="number" id="coringa-raio" placeholder="km" min="1" max="5000" step="1" style="box-sizing:border-box;padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;width:80px">
            <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="addCoringa()">Adicionar</button>
          </div>
          <div class="err" id="coringa-err"></div>
        </div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;margin-bottom:1rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.35rem">🏷 Gerenciar tags</h3>
        <p style="font-size:12px;color:var(--tx2);margin-bottom:.85rem;line-height:1.5">
          Apenas tags cadastradas aqui ficam disponíveis no autocomplete dos casos. Ao remover uma tag, ela é apagada de TODOS os casos em TODAS as bases.
        </p>
        <div id="canonical-tags-list" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:1rem;min-height:30px"></div>
        <div style="background:var(--bg);border-radius:var(--rs);padding:1rem;border:1px solid var(--bd)">
          <h4 style="font-size:13px;font-weight:600;margin-bottom:.75rem">➕ Adicionar tag</h4>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <input type="text" id="new-tag" placeholder="Ex: RINOPLASTIA, BOTOX, ESTÉTICA" maxlength="30" style="padding:7px 10px;border:1px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none;flex:1;min-width:180px" onkeydown="if(event.key==='Enter'){event.preventDefault();addCanonicalTag()}">
            <button class="btn bp" style="padding:7px 14px;font-size:13px" onclick="addCanonicalTag()">Criar</button>
          </div>
          <div class="err" id="new-tag-err"></div>
        </div>
      </div>

      <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);padding:1.25rem;box-shadow:var(--shadow-sm)">
        <h3 style="font-size:14px;font-weight:600;margin-bottom:.5rem">🕐 Cache automático (Cron)</h3>
        <p style="font-size:13px;color:var(--tx2);margin-bottom:.75rem">Configure um Cron Job no DreamHost para pré-aquecer todas as thumbs diariamente.</p>
        <code style="display:block;background:var(--bg);padding:.75rem;border-radius:var(--rs);font-size:12px;word-break:break-all">/usr/local/php83/bin/php /home/SEU_USER/casos.seudominio.com/api/cron.php</code>
      </div>
    </div>

  </div>
</div>

<!-- Painel do caso (modal) -->
<div class="ov" id="ov" onclick="ovClick(event)">
  <div class="modal painel">
    <div class="mh">
      <div>
        <div style="font-size:10px;color:var(--tx2);font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:2px">Painel do caso</div>
        <div class="mt" id="mid"></div>
      </div>
      <div style="display:flex;align-items:center;gap:4px">
        <button class="s-modal-nav" id="s-modal-prev" onclick="modalNavStep(-1)" title="Anterior (←)">‹</button>
        <span class="s-modal-pos" id="s-modal-pos"></span>
        <button class="s-modal-nav" id="s-modal-next" onclick="modalNavStep(1)" title="Próximo (→)">›</button>
        <button class="mx" onclick="closeModal()">×</button>
      </div>
    </div>
    <div class="painel-status" id="painel-status"></div>
    <div id="block-banner-wrap"></div>
    <div id="presence-banner" style="display:none;margin:0 0 .5rem;padding:8px 12px;border-radius:8px;background:var(--abg,#fff7ed);color:var(--atx,#9a3412);border:1px solid var(--atx,#9a3412);font-size:12px"></div>
    <div class="s-modal-tabs" id="s-modal-tabs">
      <button class="s-mt-btn active" data-tab="overview">Visão geral</button>
      <button class="s-mt-btn" data-tab="photos">Conteúdos <span class="s-mt-count" id="mt-photos-count">—</span></button>
      <button class="s-mt-btn" data-tab="history">Histórico <span class="s-mt-count" id="mt-history-count">—</span></button>
      <button class="s-mt-btn" data-tab="block">Bloqueio</button>
    </div>

    <!-- Panel: Visão geral -->
    <div class="s-modal-panel" data-panel="overview">
      <div class="painel-section">
        <div class="ps-title">Tags (categorias)</div>
        <div class="tag-editor" id="tag-editor"></div>
      </div>
      <div class="mb">
        <div class="is">
          <div class="it">Estados em uso</div>
          <div class="chips" id="mufs"></div>
        </div>
        <div class="is">
          <div class="it">Cidades em uso</div>
          <div class="chips" id="mcities"></div>
        </div>
        <div class="is">
          <div class="it">Profissionais</div>
          <div class="chips" id="mpers"></div>
        </div>
        <div class="is" id="remove-uso-section" style="display:none">
          <div class="it">Remover uso</div>
          <div id="remove-uso-list"></div>
        </div>
      </div>
      <div id="s-register-preview" class="s-register-preview" style="display:none"></div>
      <div class="af" id="addform" style="display:none">
        <h4>Registrar novo(s) uso(s)</h4>
        <div id="pending-usos-list" style="display:none;margin-bottom:.65rem"></div>
        <div class="fg">
          <div class="ff"><label>Estado (UF)</label><select id="auf" onchange="onAddUF()"><option value="">Selecione...</option></select></div>
          <div class="ff"><label>Cidade</label>
            <div class="ddw"><input type="text" id="aci" placeholder="Selecione estado primeiro..." readonly oninput="onAddCityInp()" onfocus="openAddCityDD()" autocomplete="off" data-val=""><div class="dd" id="acdd"></div></div>
          </div>
        </div>
        <div class="fg full">
          <div class="ff"><label>Profissional</label>
            <div class="ddw"><input type="text" id="apro" placeholder="Nome completo..." oninput="onAddProf()" autocomplete="off"><div class="dd" id="aprodd"></div></div>
            <div class="psug" id="prosug"></div>
          </div>
        </div>
        <div class="warn-box" id="state-warn"></div>
        <div style="display:flex;gap:8px;margin-top:.5rem;flex-wrap:wrap">
          <button class="btn bs" type="button" onclick="addPendingUso()" style="padding:8px 14px" title="Adiciona esta linha à lista e limpa o formulário pra você cadastrar mais uma">+ Adicionar mais um</button>
          <button class="btn bp" style="flex:1;justify-content:center" id="abtn" onclick="prepareConfirm('add')">Registrar uso</button>
          <button class="btn bs" onclick="cancelAddForm()">Cancelar</button>
        </div>
        <div class="err" id="aerr"></div>
      </div>
    </div>

    <!-- Panel: Fotos -->
    <div class="s-modal-panel" data-panel="photos" style="display:none">
      <div class="painel-photos">
        <h4>Fotos / Vídeos</h4>
        <div id="mps"><div style="padding:.5rem 0;font-size:12px;color:var(--tx2)"><span class="spin"></span> Carregando fotos...</div></div>
      </div>
    </div>

    <!-- Panel: Histórico -->
    <div class="s-modal-panel" data-panel="history" style="display:none">
      <div id="s-timeline-overview" class="s-timeline-overview"></div>
      <div id="s-timeline-full" class="s-timeline-full"></div>
    </div>

    <!-- Panel: Bloqueio -->
    <div class="s-modal-panel" data-panel="block" style="display:none">
      <div id="s-block-panel" class="s-block-panel-content" style="padding:1rem 1.6rem"></div>
    </div>

    <div class="ma" id="mact" style="flex-wrap:wrap"></div>
  </div>
</div>

<!-- Confirmação genérica -->
<div class="ov" id="confirm-modal" onclick="if(event.target===this)this.classList.remove('open')" style="z-index:600">
  <div class="modal" style="max-width:440px">
    <div class="mh"><div class="mt" id="confirm-title">Confirmar</div><button class="mx" onclick="document.getElementById('confirm-modal').classList.remove('open')">×</button></div>
    <p style="padding:.5rem 1.25rem;font-size:13px;color:var(--tx2)" id="confirm-desc"></p>
    <div class="confirm-changes" id="confirm-changes"></div>
    <div class="ma">
      <button class="btn bp" style="flex:1;justify-content:center" id="confirm-ok-btn">Confirmar</button>
      <button class="btn bs" onclick="document.getElementById('confirm-modal').classList.remove('open')">Cancelar</button>
    </div>
  </div>
</div>

<!-- Aplicar tag em massa -->
<div class="ov" id="btv" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal" style="max-width:400px">
    <div class="mh"><div class="mt">🏷 Aplicar tag em massa</div><button class="mx" onclick="this.closest('.ov').classList.remove('open')">×</button></div>
    <div style="padding:1.5rem">
      <p id="bt-info" style="font-size:13px;color:var(--tx2);margin-bottom:1rem"></p>
      <div class="fw">
        <label>Tag a aplicar</label>
        <div class="ddw">
          <input type="text" id="bt-inp" placeholder="Pesquise ou selecione uma tag..." oninput="onBulkTagInput()" onfocus="onBulkTagInput()" autocomplete="off">
          <div class="dd" id="bt-dd"></div>
        </div>
      </div>
      <div class="err" id="bt-err" style="margin-top:.5rem"></div>
      <div style="display:flex;gap:8px;margin-top:1.25rem">
        <button class="btn bp" id="bt-submit" style="flex:1;justify-content:center" onclick="submitBulkTag()">Aplicar em todos</button>
        <button class="btn bs" onclick="this.closest('.ov').classList.remove('open')">Cancelar</button>
      </div>
    </div>
  </div>
</div>

<!-- Registro em massa (grid selecionado) -->
<div class="ov" id="bav" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal">
    <div class="mh"><div class="mt">Registro em massa</div><button class="mx" onclick="this.closest('.ov').classList.remove('open')">×</button></div>
    <div style="padding:0 1.25rem .5rem;font-size:13px;color:var(--tx2)" id="bai"></div>
    <div class="berrs" id="baerrs" style="display:none;margin:0 1.25rem .5rem"></div>
    <div class="af" style="display:block;margin-top:0">
      <div class="fg">
        <div class="ff"><label>Estado</label><select id="bauf" onchange="onBulkUF('ba')"><option value="">Selecione...</option></select></div>
        <div class="ff"><label>Cidade</label><div class="ddw"><input type="text" id="baci" placeholder="Selecione estado..." readonly oninput="onBulkCityInp('ba')" onfocus="openBulkCityDD('ba')" autocomplete="off" data-val=""><div class="dd" id="bacdd"></div></div></div>
      </div>
      <div class="fg full"><div class="ff"><label>Profissional</label><div class="ddw"><input type="text" id="bapro" oninput="onBulkProf('ba')" placeholder="Nome completo..." autocomplete="off"><div class="dd" id="baprodd"></div></div><div class="psug" id="baprosug"></div></div></div>
      <div style="display:flex;gap:8px;margin-top:.5rem">
        <button class="btn bp" style="flex:1;justify-content:center" id="babtn" onclick="prepareConfirm('bulk-grid')">Registrar em todos</button>
        <button class="btn bs" onclick="this.closest('.ov').classList.remove('open')">Cancelar</button>
      </div>
      <div class="err" id="baerr"></div>
    </div>
  </div>
</div>

<!-- Registro em massa por ID -->
<div class="ov" id="biv" onclick="if(event.target===this)this.classList.remove('open')">
  <div class="modal" style="max-width:580px">
    <div class="mh"><div class="mt">Registro por ID</div><button class="mx" onclick="this.closest('.ov').classList.remove('open')">×</button></div>
    <div style="padding:0 1.25rem .75rem">
      <p style="font-size:13px;color:var(--tx2);margin-bottom:.6rem">Números separados por vírgula. Ex: <code style="background:var(--bg);padding:1px 5px;border-radius:4px">100, 200, 350</code></p>
      <div style="display:flex;gap:8px">
        <input type="text" id="biinp" placeholder="100, 200, 350..." style="flex:1;padding:8px 10px;border:0.5px solid var(--bds);border-radius:var(--rs);background:var(--sf);color:var(--tx);font-size:13px;outline:none">
        <button class="btn bs" style="padding:7px 13px;font-size:12px" onclick="parseBulkIds()">Buscar</button>
      </div>
      <div class="err" id="bierr" style="margin-top:.4rem"></div>
    </div>
    <div style="display:flex;flex-wrap:wrap;padding:0 1.25rem .75rem;max-height:180px;overflow-y:auto" id="bigrid"></div>
    <div id="biform" style="display:none">
      <div class="berrs" id="bierrs" style="display:none;margin:0 1.25rem .5rem"></div>
      <div class="af" style="margin-top:0">
        <h4 id="biform-t">Aplicar para os casos selecionados</h4>
        <div class="fg">
          <div class="ff"><label>Estado</label><select id="biuf" onchange="onBulkUF('bi')"><option value="">Selecione...</option></select></div>
          <div class="ff"><label>Cidade</label><div class="ddw"><input type="text" id="bici" placeholder="Selecione estado..." readonly oninput="onBulkCityInp('bi')" onfocus="openBulkCityDD('bi')" autocomplete="off" data-val=""><div class="dd" id="bicdd"></div></div></div>
        </div>
        <div class="fg full"><div class="ff"><label>Profissional</label><div class="ddw"><input type="text" id="bipro" oninput="onBulkProf('bi')" placeholder="Nome completo..." autocomplete="off"><div class="dd" id="biprodd"></div></div><div class="psug" id="biprosug"></div></div></div>
        <div style="display:flex;gap:8px;margin-top:.5rem">
          <button class="btn bp" style="flex:1;justify-content:center" id="bibtn" onclick="prepareConfirm('bulk-id')">Registrar uso</button>
        </div>
        <div class="err" id="bierr2"></div>
      </div>
    </div>
  </div>
</div>

<div class="ov" id="lb" onclick="this.classList.remove('open')"><img id="lbi" src="" style="max-width:92vw;max-height:88vh;border-radius:var(--r);object-fit:contain"></div>

<!-- Lightbox flutuante (visualizador de fotos) -->
<div id="lightbox-flo" onclick="if(event.target===this)closeLightboxFlo()">
  <div class="lf-info" id="lf-info"></div>
  <button class="lf-nav prev" id="lf-prev" onclick="lightboxFloNav(-1)" title="Anterior (←)">‹</button>
  <img class="lf-img" id="lf-img" alt="">
  <button class="lf-nav next" id="lf-next" onclick="lightboxFloNav(1)" title="Próximo (→)">›</button>
  <div class="lf-bar">
    <button id="lf-cloud" onclick="lightboxFloCloud()" title="Abrir no Google Drive">☁ Drive</button>
    <button id="lf-download" onclick="lightboxFloDownload()" title="Baixar diretamente">⬇ Baixar</button>
    <button class="lf-close" onclick="closeLightboxFlo()" title="Fechar (Esc)">✕ Fechar</button>
  </div>
</div>

<!-- Overlay de atalhos de teclado (? para abrir) -->
<div id="s-shortcuts" class="s-shortcuts" style="display:none" onclick="if(event.target===this)this.style.display='none'">
  <div class="s-sh-box">
    <div class="s-sh-head">
      <span>Atalhos de teclado</span>
      <button onclick="document.getElementById('s-shortcuts').style.display='none'">×</button>
    </div>
    <div class="s-sh-body">
      <div class="s-sh-group">
        <div class="s-sh-row"><kbd>?</kbd><span>Mostrar / ocultar atalhos</span></div>
        <div class="s-sh-row"><kbd>Esc</kbd><span>Fechar painel ou overlay</span></div>
      </div>
      <div class="s-sh-sep"></div>
      <div class="s-sh-group">
        <div class="s-sh-label">Dentro do painel do caso</div>
        <div class="s-sh-row"><kbd>←</kbd> <kbd>k</kbd><span>Caso anterior</span></div>
        <div class="s-sh-row"><kbd>→</kbd> <kbd>j</kbd><span>Próximo caso</span></div>
      </div>
    </div>
  </div>
</div>

<div id="sync-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:900;align-items:center;justify-content:center;padding:1rem" onclick="if(event.target===this)closeSyncModal()">
  <div style="background:var(--sf);border:1px solid var(--bd);border-radius:var(--r);width:100%;max-width:560px;max-height:85vh;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--bd)">
      <h3 style="font-size:15px;font-weight:700;margin:0">🔄 Sincronizar Drive ↔ planilha</h3>
      <button onclick="closeSyncModal()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--tx3);line-height:1">×</button>
    </div>
    <div id="sync-modal-body" style="padding:1.25rem;overflow:auto;font-size:13px"></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>window.TURNSTILE_ENABLED = <?php echo $TURNSTILE_SITE_KEY !== '' ? 'true' : 'false'; ?>;
window.APP_BUILD_EXPECTED = <?php echo json_encode(jsBuild()); ?>;</script>
<!-- A ordem dos scripts é significativa: utils define globais usados pelos demais. -->
<script src="<?php echo v('assets/utils.js'); ?>"></script>
<script src="<?php echo v('assets/theme.js'); ?>"></script>
<script src="<?php echo v('assets/casos.js'); ?>"></script>
<script src="<?php echo v('assets/panel.js'); ?>"></script>
<script src="<?php echo v('assets/bulk.js'); ?>"></script>
<script src="<?php echo v('assets/admin.js'); ?>"></script>
<script src="<?php echo v('assets/auth.js'); ?>"></script>
<script src="<?php echo v('assets/app.js'); ?>"></script>
</body>
</html>
