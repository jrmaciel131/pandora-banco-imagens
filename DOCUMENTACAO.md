# Banco de Imagens — Documentação Técnica

Versão da aplicação: **v23** · Última revisão: 2026-07-14

Esta documentação descreve a arquitetura, os componentes e os fluxos operacionais do sistema **Banco de Imagens**, uma aplicação web destinada à consulta, marcação e auditoria de uso de casos cadastrados em planilhas do Google Sheets, com as fotos hospedadas no Google Drive.

---

## Sumário

1. Visão geral
2. Arquitetura
3. Estrutura de diretórios
4. Configuração
5. Modelo de dados
6. API HTTP
7. Frontend (assets modulares)
8. Cache e desempenho
9. Segurança
10. Operação e manutenção
11. Histórico de mudanças

---

## 1. Visão geral

A aplicação centraliza o controle dos casos cadastrados pela equipe, oferecendo:

- Catálogo paginado das fotos de cada caso, com geração de thumbnails locais.
- Registro do uso por estado, cidade e profissional.
- Bloqueio/desbloqueio de casos e gerenciamento de tags (com suporte a caracteres acentuados).
- Histórico completo de auditoria com possibilidade de reversão.
- Múltiplas bases independentes (TESTE, PH, PO) com permissões por usuário.
- Painel de diagnóstico, gerenciamento de usuários e exportação de casos.

A integração externa se dá com **Google Sheets** (fonte de verdade dos casos) e **Google Drive** (armazenamento das fotos), via conta de serviço autenticada por **JWT**.

---

## 2. Arquitetura

A aplicação adota uma arquitetura monolítica em PHP com frontend modular em HTML/CSS/JavaScript estáticos, persistindo o estado em **MySQL** e em arquivos JSON na pasta privada. Todos os dados sensíveis residem fora do document root.

```
┌──────────────────────┐        ┌─────────────────────┐
│   Frontend (HTML)    │  AJAX  │  api/handler.php    │
│  index.html + assets/│ ──────►│  (front controller) │
└──────────────────────┘        └─────────┬───────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
      ┌──────────────┐           ┌──────────────┐            ┌──────────────┐
      │    MySQL     │           │  Google API  │            │  Filesystem  │
      │  (cache,     │           │   (Sheets +  │            │   (thumbs/,  │
      │   auditoria) │           │    Drive)    │            │   sessions)  │
      └──────────────┘           └──────────────┘            └──────────────┘
```

A pasta privada `private-config/` contém configurações, credenciais e bibliotecas (`db.php`, `google.php`) e deve ser instalada **fora** do document root público para evitar exposição via HTTP.

---

## 3. Estrutura de diretórios

```
raizdosite/
├── DEPLOY.md                              Notas de deploy e hardening do servidor.
├── DOCUMENTACAO.md                        Este documento.
│
├── adm1-projectcasos.euemeunegocio.com/   Document root público.
│   ├── index.php                          Markup principal; gera cache busting automático e injeta o build esperado.
│   ├── ajuda.html                         Documentação interna em formato de tutorial.
│   ├── 403.html / 404.html / 500.html     Páginas de erro com redirect automático.
│   ├── assets/                            Bundles modulares de CSS/JS (v21+).
│   │   ├── theme.css                      Variáveis de tema (light/dark).
│   │   ├── app.css                        Componentes, layout, modais.
│   │   ├── utils.js                       Helpers, cliente HTTP, primitives de UI.
│   │   ├── theme.js                       Tema, FAB de métricas, tour guiado.
│   │   ├── auth.js                        Login, sessão e seleção de base.
│   │   ├── casos.js                       Grade, filtros, paginação, thumbnails.
│   │   ├── panel.js                       Painel do caso, chips, tags, add/remove uso.
│   │   ├── bulk.js                        Operações em lote e lightbox flutuante.
│   │   ├── admin.js                       Admin Mode, histórico, diagnóstico.
│   │   └── app.js                         Bootstrap (último carregado).
│   ├── api/
│   │   ├── handler.php                    Front controller da API JSON.
│   │   ├── cron.php                       Cache warmer + sync Drive↔planilha (CLI ou HTTP autenticado).
│   │   ├── gerar-hash.php                 Gerador de hash bcrypt (página admin-only).
│   │   └── .htaccess                      Restrições de acesso (allowlist de .php).
│   ├── export/
│   │   ├── index.html                     Ferramenta de exportação de casos.
│   │   └── lib/jszip.min.js               JSZip hospedado localmente (sem CDN).
│   ├── thumbs/                            Cache de thumbnails da base PH.
│   ├── thumbs-po/                         Cache de thumbnails da base PO.
│   ├── thumbs-teste/                      Cache de thumbnails da base TESTE.
│   └── favicon.ico, favicon.gif
│
└── private-config/                        Pasta privada (fora do document root).
    ├── config.php                         Constantes globais e definição das bases.
    ├── secrets.local.php                  Segredos reais: DB_PASS, CRON_KEY, Turnstile (NÃO versionado).
    ├── google-credentials.json            Credenciais da conta de serviço Google.
    ├── passwords.json                     Sobrescritas dinâmicas de senhas.
    ├── users_override.json                Usuários criados via interface.
    ├── production_users.json              Mapa de usuários com acesso à produção.
    ├── tags.json                          (v21.1) Lista canônica de tags gerenciada pelo admin.
    ├── cidades_coords.csv                 (v21.1) Coordenadas dos municípios brasileiros (IBGE) — usado pela validação de distância.
    ├── LEIA-ME.txt                        Notas operacionais.
    ├── lib/
    │   ├── db.php                         Camada PDO/MySQL.
    │   └── google.php                     Cliente das APIs Google.
    └── sessions/                          Sessões PHP fora do document root.
```

---

## 4. Configuração

Todas as constantes globais ficam em `private-config/config.php`. As principais são apresentadas abaixo.

| Constante               | Descrição                                                                 |
|-------------------------|---------------------------------------------------------------------------|
| `APP_VERSION`           | Versão exibida no header do frontend.                                     |
| `WEB_ROOT`              | Caminho absoluto do document root público.                                |
| `PRIVATE_CONFIG_PATH`   | Caminho da pasta privada (resolve arquivos JSON auxiliares).              |
| `USERS`                 | Usuários estáticos (login, hash bcrypt, papel).                           |
| `BASES`                 | Bases disponíveis (planilha, pasta Drive, prefixo de tabelas).            |
| `PRODUCTION_BASES`      | Subconjunto de bases tratadas como produção.                              |
| `GOOGLE_CREDENTIALS_PATH` | Caminho do JSON da conta de serviço.                                    |
| `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASS` | Credenciais do MySQL.                                       |
| `CACHE_TTL`             | TTL (s) do cache de leitura da planilha.                                  |
| `THUMB_CACHE_TTL`       | TTL (s) do cache físico de thumbnails.                                    |
| `FOLDER_CACHE_TTL`      | TTL (s) do cache de subpastas do Drive.                                   |
| `SESSION_LIFETIME`      | Duração da sessão (s). **v21: 7200 (2h)** — antes 14400 (4h).             |
| `SESSION_WARN_BEFORE`   | Antecedência (s) para o aviso de expiração.                               |
| `MAX_LOGIN_ATTEMPTS`    | Tentativas antes do bloqueio (por usuário+dispositivo desde v21).         |
| `LOGIN_BLOCK_MINUTES`   | Duração do bloqueio (min).                                                |
| `CRON_KEY`              | Chave necessária para invocar o cache warmer via HTTP.                    |
| `DISTANCE_RADIUS_KM`    | Raio mínimo (km) entre uma cidade nova e qualquer já em uso no mesmo caso. Default: 80. Apenas admin pode prosseguir em caso de conflito. **v21.2:** o valor pode ser sobrescrito em runtime por `private-config/distance_config.json` (gravado pelo painel admin); cidades coringa (raio reduzido) em `distance_overrides.json` — em pares mistos vale `min(raioA, raioB)`. **(v23.21)** Acima dele existe o raio de atenção (`alert_radius_km`, dobro do mínimo por padrão), faixa em que o registro só pede confirmação. |

### Bases

Cada entrada da constante `BASES` agrupa os parâmetros de uma fonte de dados:

| Chave             | Significado                                                              |
|-------------------|--------------------------------------------------------------------------|
| `label`           | Rótulo exibido na interface.                                             |
| `emoji`           | Ícone que acompanha o rótulo.                                            |
| `spreadsheet_id`  | Identificador da planilha do Google Sheets.                              |
| `sheet_name`      | Nome da aba (worksheet).                                                 |
| `drive_folder_id` | Pasta-raiz do Drive onde estão as fotos.                                 |
| `thumb_dir`       | Caminho absoluto local do cache de thumbnails da base.                   |
| `thumb_base_url`  | URL pública para servir os thumbnails ao frontend.                       |
| `db_prefix`       | Prefixo aplicado aos nomes das tabelas MySQL (isola dados por base).     |
| `is_test`         | Flag opcional que marca a base como sandbox.                             |

---

## 5. Modelo de dados

Cada base mantém um conjunto independente de tabelas, identificado pelo prefixo configurado em `db_prefix`.

| Tabela            | Função                                                                    |
|-------------------|---------------------------------------------------------------------------|
| `thumb_cache`     | Cache JSON das fotos por caso (thumbnail local, metadados).               |
| `folder_cache`    | Cache da árvore de subpastas do Drive.                                    |
| `sheet_cache`     | Cache do conteúdo da planilha (faixa A:G).                                |
| `audit_log`       | Histórico de operações: usuário, ação, snapshot antes/depois, IP, UA.    |
| `login_attempts`  | Contagem de falhas e bloqueios — coluna `ip` agora é VARCHAR(120) e armazena chaves no formato `u:USUARIO:d:DEVICE` ou `u:USUARIO:i:IP`. |

A criação é idempotente em `DB::setup()`, executado no bootstrap do `handler.php` e do `cron.php` para todas as bases configuradas. A migração da coluna `ip` para VARCHAR(120) (v21) é aplicada automaticamente via `ALTER TABLE ... MODIFY COLUMN` (no-op em bases já migradas).

### Caso (linha da planilha)

A planilha possui as colunas **A:G** lidas pela aplicação:

| Coluna | Conteúdo                                                  |
|:------:|-----------------------------------------------------------|
| A      | Reservada (não usada).                                    |
| B      | Identificador do caso (`CASO-<n>`).                       |
| C      | UFs separadas por `/` ou `-`. Marcadores `NA` ou `LINDA` indicam bloqueio. |
| D      | Cidades (separadas por `/`).                              |
| E      | Clientes/Profissionais (separados por `/`).               |
| F      | Tags (separadas por `/` ou `,`). Normalizadas em maiúsculas via `mb_strtoupper` — acentos preservados. |
| G      | Motivo do bloqueio (texto livre).                         |

---

## 6. API HTTP

Todas as requisições são despachadas pelo front controller `api/handler.php`. O endpoint usa o parâmetro `action` (GET ou POST) para distinguir a operação. Salvo nos endpoints de download binário, a resposta é sempre `application/json` com o contrato `{ ok: bool, ... }`.

### Sessão e autenticação

| Ação              | Método | Descrição                                                            |
|-------------------|:------:|----------------------------------------------------------------------|
| `login`           | POST   | Autentica; valida Turnstile quando ativo; aplica rate limiting por (usuário+dispositivo). Emite cookie `bi_device` e devolve o token CSRF em login bem-sucedido. |
| `logout`          | GET    | Encerra a sessão.                                                    |
| `check_session`   | GET    | Restaura o estado da sessão sem redirect (chamado em F5).            |
| `renew_session`   | GET    | Renova o timestamp da sessão.                                        |

### Bases

| Ação           | Método | Descrição                                                                |
|----------------|:------:|--------------------------------------------------------------------------|
| `get_bases`    | GET    | Lista bases visíveis ao usuário, com a base ativa e flag de produção.    |
| `switch_base`  | POST   | Troca a base ativa e devolve os casos da nova base.                      |

### Casos e fotos

| Ação            | Método | Descrição                                                                              |
|-----------------|:------:|----------------------------------------------------------------------------------------|
| `casos`         | GET    | Lista casos da base ativa (`force` ignora cache).                                     |
| `photos`        | GET    | Fotos de um caso. `source=auto/cache/drive` permite forçar a fonte.                    |
| `cache_status`  | GET    | Verifica em lote o estado de cache de até N IDs.                                       |
| `new_files`     | GET    | Arquivos novos no Drive (últimos 7 dias).                                              |
| `add_uso`       | POST   | Registra uso (UF, cidade, profissional). Aplica lock otimista por caso. **v21.1:** UF não duplica no Sheets; check de distância (`DISTANCE_RADIUS_KM`). **(v23.20)** O profissional também não duplica: quem já consta no caso não é acrescentado de novo. |
| `add_uso_batch` | POST   | **(v21.1)** Registro atômico de várias linhas no mesmo caso. Pré-flight valida tudo antes do write; nenhuma linha é gravada se houver erro. Payload: `entries` (JSON array). **(v23.20)** O mesmo profissional em várias cidades do lote entra uma vez só na coluna de clientes. |
| `bulk_preflight`| POST   | **(v21.1)** Verifica em lote antes do registro em massa: cidade-block, bloqueio, distância. Devolve `errors[]` e `warns[]`. **(v23.15)** Aceita `entries` (JSON array de trios) para registrar vários locais de uma vez; o formato antigo `uf`/`cidade`/`profissional` segue valendo como uma linha. |
| `audit_data`    | GET    | **(v21.1, admin)** Varre todos os casos de todas as bases procurando UFs inválidas, cidades não reconhecidas pelo CSV (com sugestões fuzzy via Levenshtein), cidades cadastradas em UF errada e duplicatas com escritas diferentes. Usado pra limpar a planilha antes da validação por distância funcionar bem. |
| `audit_distances`     | GET    | **(v21.2, admin)** Simula a regra de raio mínimo sobre os casos existentes: aponta pares de cidades no mesmo caso a uma distância em linha reta menor ou igual ao raio efetivo do par (`min(raioA, raioB)`). |
| `get_distance_config` | GET    | **(v21.2, admin)** Retorna o `DISTANCE_RADIUS_KM` em vigor (lê o override de `distance_config.json` quando presente). **(v23.21)** Devolve também o `alert_radius_km` efetivo. |
| `set_distance_config` | POST   | **(v21.2, admin)** Grava o novo raio padrão em `distance_config.json` (faixa 1–5000 km). Vale a partir da próxima requisição. **(v23.21)** Aceita `alert_radius_km` (≥ raio mínimo); em branco apaga o valor gravado e volta ao dobro. |
| `list_distance_overrides`  | GET    | **(v21.2, admin)** Lista as cidades coringa cadastradas em `distance_overrides.json`, já resolvendo o nome canônico pelo CSV de coordenadas. |
| `add_distance_override`    | POST   | **(v21.2, admin)** Cadastra/atualiza uma cidade coringa (UF + cidade do CSV + raio em km). Recusa raio maior que o padrão. |
| `remove_distance_override` | POST   | **(v21.2, admin)** Remove uma cidade coringa pela chave `UF\|CIDADE_NORMALIZADA`. |
| `remove_uso`    | POST   | Remove uma entrada inteira por índice.                                                 |
| `remove_item`   | POST   | Remove uma única UF, cidade ou cliente, opcionalmente por índice.                      |
| `set_block`     | POST   | Bloqueia caso adicionando o marcador `NA` e gravando o motivo.                         |
| `unblock_case`  | POST   | Remove os marcadores e o motivo (admin).                                               |
| `add_tag`       | POST   | Acrescenta tag (máx. 30 caracteres, 20 tags por caso). **v21.1:** valida contra a lista canônica antes de gravar. |
| `remove_tag`    | POST   | Remove tag (idempotente).                                                              |
| `list_tags`     | GET    | Lista de tags em uso nos casos (alimenta o filtro do grid).                            |
| `list_canonical_tags` | GET    | **(v21.1)** Lista canônica gerenciada pelo admin (alimenta o autocomplete no painel do caso). Migra automaticamente na primeira execução. |
| `add_canonical_tag`   | POST   | **(v21.1, admin)** Adiciona uma tag à lista canônica.                              |
| `remove_canonical_tag`| POST   | **(v21.1, admin)** Remove da lista canônica E em cascata de todos os casos em todas as bases. |

### Histórico e reversões

| Ação            | Método | Descrição                                                              |
|-----------------|:------:|------------------------------------------------------------------------|
| `historico`     | GET    | Lista de entradas do `audit_log`. **v21:** `limit` aceita até 100000.   |
| `revert_caso`   | POST   | Reaplica um snapshot anterior (admin).                                 |

### Cache

| Ação           | Método | Descrição                                                                |
|----------------|:------:|--------------------------------------------------------------------------|
| `clear_cache`  | POST   | Limpa o cache de um caso (`caso_id`), de um lote (`caso_ids`) ou de toda a base (admin); apaga as thumbnails locais. |
| `speed_test`   | GET    | Compara o tempo de resposta entre Drive e cache local (admin).           |
| `diagnostico`  | GET    | Health-check completo do ambiente (admin).                               |
| `test_log`     | GET    | Diagnóstico do `audit_log`: grava e relê uma entrada.                    |

### Usuários (admin)

Todas as operações de escrita em arquivos JSON usam o helper `withJsonLock()` (v21) com `flock(LOCK_EX)` para evitar perda silenciosa em chamadas concorrentes.

| Ação                     | Método | Descrição                                                  |
|--------------------------|:------:|------------------------------------------------------------|
| `list_users`             | GET    | Usuários conhecidos com último login e contagem 30 dias.   |
| `add_user`               | POST   | Cria usuário em `users_override.json`.                     |
| `remove_user`            | POST   | Remove usuário dinâmico.                                   |
| `change_password`        | POST   | Troca a senha do usuário-alvo: grava em `users_override.json` (usuários dinâmicos) ou `passwords.json` (estáticos do `config.php`). Um admin não altera a senha de outro admin. |
| `set_production_access`  | POST   | Concede ou revoga acesso à produção em `production_users.json`. |

### Downloads

| Ação              | Método | Conteúdo                                                                   |
|-------------------|:------:|----------------------------------------------------------------------------|
| `download_photo`  | GET    | Stream do arquivo individual do Drive.                                     |
| `download_bulk`   | POST   | ZIP com até 30 casos. Cada subpasta no ZIP corresponde ao identificador. **(v23.16)** Escrito em fluxo, sem montar o pacote antes de responder: evita o 524 do Cloudflare. Falhas parciais viram `_ERROS.txt` dentro do próprio ZIP. **(v23.17)** Manda o tamanho previsto em `X-Zip-Total`. **(v23.18)** Aceita `file_ids` com a seleção do usuário; só imagem e vídeo entram. **(v23.21)** Com `flat=1` o pacote sai sem subpastas, e nomes repetidos entre casos ganham o ID do caso na frente. |
| `bulk_manifest`   | POST   | **(v23.18)** Inventário dos arquivos dos casos selecionados, classificado em logo / formato / versão e com tamanho, para a janela de seleção do download. |

---

## 7. Frontend (assets modulares)

A partir da v21 o frontend foi dividido em módulos servidos pela pasta `assets/`. O `index.php` contém apenas o markup + as tags `<link>` e `<script>` referenciando os bundles; o sufixo `?v=` de cada referência é gerado automaticamente a partir do `filemtime()` do arquivo (cache busting sem intervenção manual).

### Ordem de carregamento

A ordem é significativa porque todos os arquivos compartilham o mesmo escopo global (sem `import/export`):

```
theme.css → app.css
↓
utils.js → theme.js → casos.js → visualizador.js → disponibilidade.js → panel.js → bulk.js → admin.js → auth.js → app.js
```

### Responsabilidades

| Arquivo     | Conteúdo                                                                                  |
|-------------|-------------------------------------------------------------------------------------------|
| `theme.css` | Variáveis CSS de light/dark, reset global.                                                |
| `app.css`   | Componentes, layout, modais, grade, lightbox, painel admin.                               |
| `utils.js`  | `api()`, `esc/cap/norm`, `showToast/showConfirm`, `renderDD/renderFormDD`, `lev`, `ESTADOS`, `populateEstados`, `togglePwd`, `buildProfAC`, `API`. |
| `theme.js`  | IIFE inicial (aplica tema salvo), `setTheme`, `updateThemeButtons`, `initFAB`, `openHelp`, `startTour`. |
| `casos.js`  | Estado da grade (`casos`, `filtered`, `page`, `mode`, `thumbCache`, etc.), `loadCasos`, `applyFilter`, `renderGrid`, filtros de UF/cidade/profissional/tags, paginação, `lazyLoadThumbs`. |
| `visualizador.js` | `exportVisualizadorPDF` — documento imprimível em grade com os casos em uso pelos profissionais filtrados (todas as versões). |
| `disponibilidade.js` | `exportDisponibilidadePDF` — documento imprimível separando os casos do profissional entre livres e em uso na praça filtrada (`dispScore`, `pickDisponibilidadePhotos`). |
| `panel.js`  | `currentCaso`, `pendingRemovals`, `openModal`, `renderModalChips`, editor de tags, add/remove de uso, bloqueio/desbloqueio, `loadIBGE`. |
| `bulk.js`   | `selMode`, `selIds`, `bulkSelIds`, `bulkCities`, lightbox flutuante, `downloadBulkZip`, registro em massa por grid e por ID, `parseBulkIds`. |
| `admin.js`  | `adminModeVisible`, `thumbSourceMode`, painel administrativo, histórico/reversões, `runDiag`, gerenciamento de usuários e senhas, cache. |
| `auth.js`   | `currentBase`, `availableBases`, `userRole`, `doLogin/doLogout`, `selectBase/switchBase`, `checkSessionOnLoad`, banner de modo TESTE. |
| `app.js`    | `initApp()` + chamada inicial `checkSessionOnLoad()`. Carregado por último.               |

### Cache busting e verificação de build

Desde a v23 o cache busting é automático: o `index.php` anexa `?v=<filemtime>` a cada asset, então basta subir o arquivo alterado — o timestamp novo força o recarregamento.

Como o site fica atrás do Cloudflare (que pode segurar JS/CSS em cache), há uma verificação extra: `utils.js` declara a constante `APP_BUILD`, e o `index.php` injeta em `window.APP_BUILD_EXPECTED` o valor lido do arquivo no servidor. Se o navegador estiver executando um `utils.js` antigo, os valores divergem e uma faixa avisa o usuário para recarregar. **Ao alterar qualquer asset num release, atualize o `APP_BUILD` em `utils.js`.**

---

## 8. Cache e desempenho

A camada de cache é distribuída em três níveis:

1. **Memória do PHP (intra-request)** — token OAuth e leituras pontuais.
2. **MySQL (inter-request)** — `thumb_cache`, `folder_cache` e `sheet_cache`.
3. **Disco (filesystem)** — arquivos `*.jpg` e `*.webp` em `thumbs*`.

Ações que invalidam parcialmente o cache:

- Qualquer escrita em `updateCaso*` invalida `sheet_cache` da base ativa.
- `clear_cache` apaga as entradas de `thumb_cache` e os arquivos físicos correspondentes.
  - `caso_id` limpa um caso; `caso_ids` (lista separada por vírgula, espaço ou quebra de linha, teto de
    `CLEAR_CACHE_MAX_IDS` = 100) limpa um lote; sem nenhum dos dois, limpa a base inteira (admin).
  - O lote existe porque `THUMB_CACHE_TTL` é de 30 dias: quando um arquivo entra na pasta errada no
    Drive e depois é removido de lá, os casos afetados continuam exibindo a listagem antiga até a
    limpeza. Na interface: barra de seleção da grade (botão "Limpar cache") e Admin Mode
    ("Limpar cache de casos específicos", por lista de IDs). A operação é registrada no `audit_log`
    como `clear_cache_batch`.
  - `folder_cache` não entra no lote: ele é global e expira sozinho em `FOLDER_CACHE_TTL` (1 hora).
- O cache warmer (`api/cron.php`) percorre todas as bases e regenera o cache faltante.

O download das thumbnails é paralelizado por meio de stream contexts não-bloqueantes (`GoogleAPI::downloadThumbsBatch()`), reduzindo o tempo total de N×T para aproximadamente max(T).

---

## 9. Segurança

O sistema aplica **defesa em camadas**: cada mecanismo assume que o anterior pode falhar. Visão geral:

| # | Camada | Protege contra | Mecanismo principal |
|---|--------|----------------|---------------------|
| 1 | Estrutura de arquivos | Vazamento de segredos via HTTP | `private-config/` fora do document root + allowlist no `.htaccess` |
| 2 | Senhas | Vazamento de credenciais | Hashes bcrypt (`PASSWORD_DEFAULT`) — nunca senha em texto puro |
| 3 | Login | Força bruta e bots | Rate limit por (usuário, dispositivo) + Turnstile opcional |
| 4 | Sessão | Sequestro/fixação de sessão | Cookie `httponly`/`samesite`, 2 h, `session_regenerate_id()` |
| 5 | Requisições POST | CSRF | Token por sessão no cabeçalho `X-CSRF-Token` |
| 6 | Autorização | Escalada de privilégio | Papéis `admin`/`user` verificados no backend |
| 7 | Concorrência | Corrupção de dados | Locks por caso e por arquivo JSON |
| 8 | Auditoria | Ações não rastreáveis | `audit_log` com snapshots antes/depois |

### 9.1 Hardening estrutural

- A pasta `private-config/` reside **fora** do document root: nada nela é alcançável por URL, independentemente de `.htaccess`. É onde vivem credenciais, hashes, sessões e os JSONs de estado.
- `api/.htaccess` usa **allowlist**: só `handler.php`, `cron.php` e `gerar-hash.php` respondem; qualquer outro `.php` em `/api/` é negado. Endpoints legados (`config/`, `api/db.php`, `api/google.php`) respondem HTTP 410 (Gone).
- Sessões PHP gravadas em `private-config/sessions/` (não no diretório temporário compartilhado da hospedagem).
- Permissões restritivas no servidor: `700` nas pastas privadas, `600` nos arquivos (ver `DEPLOY.md`).

### 9.2 Senhas — por que hash, o que é e qual usamos

O sistema **nunca armazena senhas em texto puro** — nem no banco, nem em arquivo. O que fica gravado é um **hash**: o resultado de uma função de mão única que transforma a senha numa sequência de tamanho fixo. Não existe caminho de volta — a partir do hash não se recupera a senha.

No login, o PHP aplica a mesma função à senha digitada e compara com o hash armazenado (`password_verify()`). Se baterem, a senha está correta. Assim, mesmo que o `config.php` ou um backup vaze, o atacante não obtém as senhas — o que importa especialmente porque as pessoas reutilizam senhas em outros serviços.

E não é um hash qualquer. Usamos **bcrypt**, via `password_hash($senha, PASSWORD_DEFAULT)` — um algoritmo desenhado especificamente para armazenar senhas, ao contrário de MD5/SHA-256, que são rápidos demais (e por isso fáceis de atacar por força bruta). Anatomia de um hash bcrypt:

```
$2y$12$T7fqPWCvY0lXhAB2ZqM9T.WvUXAmiEHW1YvBHJTAsF2kZo0diTdW6
 │   │ └──────────┬─────────┘└────────────┬────────────────┘
 │   │       salt (22 chars)      hash da senha (31 chars)
 │   └── custo: 2^12 = 4096 iterações
 └────── algoritmo (2y = bcrypt)
```

- **Salt** — valor aleatório gerado a cada `password_hash()` e embutido no resultado. Duas contas com a *mesma* senha produzem hashes diferentes, o que inutiliza tabelas pré-calculadas (rainbow tables) e impede notar senhas repetidas.
- **Custo (work factor)** — bcrypt é deliberadamente lento: custo N significa 2^N iterações. Alguns milissegundos num login legítimo, mas proibitivo para quem precisa testar bilhões de combinações.
- **`PASSWORD_DEFAULT`** — deixa o PHP escolher o melhor algoritmo disponível. Como o algoritmo e o custo ficam gravados no próprio hash, `password_verify()` continua validando hashes antigos mesmo se o padrão mudar em versões futuras do PHP.

### 9.3 Onde as senhas vivem — e a ordem de precedência

Três arquivos participam, todos em `private-config/`:

| Arquivo | O que contém | Quem escreve |
|---------|--------------|--------------|
| `config.php` (constante `USERS`) | Usuários estáticos: login, hash, papel | Editado à mão |
| `users_override.json` | Usuários criados pelo painel admin | A aplicação (`add_user`) |
| `passwords.json` | Trocas de senha feitas pelo painel | A aplicação (`change_password`) |

Na autenticação (`getUserData()` no `handler.php`), a resolução é:

```
1. users_override.json  → se o usuário existe aqui, este é o cadastro-base
2. USERS (config.php)   → senão, procura nos usuários estáticos
3. passwords.json       → POR CIMA de qualquer um dos dois: se houver entrada
                          para o usuário, o hash dela SUBSTITUI o hash-base
```

> ⚠️ **Consequência prática:** trocar o hash no `config.php` **não surte efeito** se o usuário tiver uma entrada em `passwords.json` no servidor (deixada por uma troca de senha antiga via painel). Nesse caso, remova a entrada dele do `passwords.json`.

### 9.4 Como gerar um hash e trocar senhas

**No dia a dia — pelo painel admin** (ação `change_password`): grava o novo hash no arquivo certo automaticamente. Salvaguarda: um admin pode trocar a própria senha e a de usuários comuns, mas **não** a de outro admin.

**Quando a senha de um admin foi esquecida** — é preciso editar o `config.php`:

1. Gere o hash da senha nova por um destes caminhos:
   - **`api/gerar-hash.php`** — página protegida (exige login de admin): digite a senha, copie o hash;
   - **localmente**: `php -r "echo password_hash('NOVA_SENHA', PASSWORD_DEFAULT), PHP_EOL;"`
2. Cole o hash na linha do usuário em `USERS` (`config.php`) e suba o arquivo para `private-config/` no servidor.
3. Confira o `passwords.json` no servidor: se houver entrada para esse usuário, apague-a (ver 9.3).

### 9.5 O que acontece num login (passo a passo)

1. **Turnstile** (opcional, v23): se as chaves estiverem configuradas em `secrets.local.php`, o token anti-bot da Cloudflare é validado no servidor antes de qualquer outra checagem.
2. **Rate limiting por (usuário, dispositivo)**: o servidor emite um cookie `bi_device` (httpOnly, 2 anos) no primeiro login bem-sucedido; as falhas são contadas pela chave `u:USUARIO:d:DEVICE` (fallback `u:USUARIO:i:IP` sem cookie). Exceder `MAX_LOGIN_ATTEMPTS` bloqueia por `LOGIN_BLOCK_MINUTES`. A chave por dispositivo evita que uma pessoa errando a senha bloqueie a empresa inteira atrás do mesmo IP público.
3. **Verificação da senha**: resolução do usuário (seção 9.3) + `password_verify()`.
4. **Sucesso**: contador de falhas zerado, `session_regenerate_id(true)` para prevenir session fixation, e o **token CSRF** da sessão é devolvido ao frontend.

### 9.6 Sessões

- Cookie `bi_session` com `httponly` (inacessível ao JavaScript), `samesite=Lax` (mitiga CSRF) e `secure` sob HTTPS; `use_strict_mode` rejeita IDs de sessão forjados.
- Duração de **2 horas** (`SESSION_LIFETIME`), com renovação automática enquanto o usuário está ativo e aviso antes de expirar.
- Arquivos de sessão em `private-config/sessions/`, fora do document root.

### 9.7 CSRF

CSRF (*cross-site request forgery*) é quando um site malicioso dispara, pelo navegador de um usuário logado, uma requisição ao nosso sistema sem que ele perceba. Proteção (v23): no login é gerado um token aleatório de 32 bytes por sessão; **toda ação POST autenticada** precisa reenviá-lo no cabeçalho `X-CSRF-Token` (o frontend faz isso sozinho). A comparação usa `hash_equals()` (timing-safe). Ações GET são somente leitura e não exigem token.

### 9.8 Autorização (papéis)

- Papéis: `admin` (acesso total) e `user` (limitado às bases visíveis e ações de registro).
- `production_users.json` concede acesso a bases de produção a usuários comuns.
- Toda ação restrita é verificada **no backend** (`requireAdmin`), nunca apenas escondida na interface.
- Nenhum admin pode alterar a senha ou remover outro admin via API.

### 9.9 Concorrência e integridade

- `acquireCaseLock()` serializa escritas concorrentes no mesmo caso (timeout 10 s) — cobre registro de uso, bloqueio e tags.
- `withJsonLock()` (`flock(LOCK_EX)`) serializa leitura-modificação-escrita nos JSONs de configuração (`passwords.json`, `users_override.json`, `production_users.json`).
- A escrita em Sheets é tentada até três vezes com backoff linear; a edição simultânea usa lock otimista + aviso de presença (v23).

### 9.10 Proteções HTTP

- `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY` nas respostas JSON e no `gerar-hash.php`; `download_photo` e `download_bulk` os removem antes do stream binário.
- `cron.php` autenticado preferencialmente pelo cabeçalho `X-Cron-Key` (não vaza em logs de acesso), comparado com `hash_equals`; `?key=` GET mantido por compatibilidade.

### 9.11 Segredos e o que nunca vai para o Git

- `secrets.local.php` (v23): `DB_PASS`, `CRON_KEY` e chaves do Turnstile — **não versionado** (`.gitignore`); sobe uma única vez por SFTP.
- Também fora do Git (ou versionados apenas com placeholders): `google-credentials.json`, `passwords.json`, `users_override.json`, `production_users.json`.
- No repositório público, o `config.php` é versionado **sempre com placeholders** — nunca com hashes, IDs ou domínios reais.

---

## 10. Operação e manutenção

### Cache warmer

O script `api/cron.php` percorre todas as bases configuradas e força a recriação dos thumbnails ausentes em disco.

- **CLI** (preferido): pode ser agendado como cron de sistema invocando `php api/cron.php`.
- **HTTP**: agora autenticado por header `X-Cron-Key: <CRON_KEY>`. O parâmetro `?key=` continua aceito para compatibilidade mas deve ser migrado.

```
# CLI (DreamHost)
/usr/local/php83/bin/php /home/SEU_USER/adm1-projectcasos.../api/cron.php

# HTTP via curl (preferido sobre ?key=)
curl -s -H "X-Cron-Key: SEU_CRON_KEY" https://seu-site.com/api/cron.php
```

### Diagnóstico

O endpoint `diagnostico` (admin) verifica:

- Versão do PHP e extensões necessárias (`openssl`, `pdo_mysql`).
- Permissões de escrita no diretório de thumbs.
- Conexão MySQL e existência do `audit_log`.
- Validade do `google-credentials.json` e do token OAuth.
- Acesso às APIs Sheets e Drive.
- Estatísticas de cache (registros e arquivos físicos).

### Logs

- Erros de bootstrap são registrados via `error_log()` com o prefixo `[banco-imagens]`.
- Operações de negócio são gravadas no `audit_log` (incluindo IP e user-agent), com retenção indefinida.

### Backups recomendados

- Banco MySQL (todas as tabelas, especialmente `audit_log`).
- Pasta `private-config/` (configurações e credenciais).
- Diretórios `thumbs*` (regeneráveis pelo cache warmer, mas o backup acelera a recuperação).

---

## 11. Histórico de mudanças

### v23.21 (2026-09-08)

**Estrutura do ZIP, faixa de atenção na regra de distância e filtro de interseção por profissional.**

O download em lote passou a perguntar como o pacote deve sair: uma subpasta por caso (padrão de sempre) ou todos os arquivos soltos na raiz. A escolha fica em `localStorage` (`bi_dl_flat`) e vai ao backend em `flat`. Sem subpastas dois casos podem trazer arquivos de mesmo nome; o primeiro mantém o nome original e os seguintes entram como `CASO-XXX - nome.jpg`, com sufixo numérico se ainda assim colidirem, então nenhum arquivo se perde na extração.

A regra de distância ganhou uma segunda faixa. O raio mínimo continua bloqueando (usuário comum barrado, admin confirma com `force`), e acima dele existe agora o **raio de atenção** (`alert_radius_km` em `distance_config.json`, editável no painel admin, igual ao dobro do mínimo quando não informado): nessa faixa qualquer usuário registra, mas só depois de confirmar. O gatilho foi concreto: com raio de 15 km, São Paulo a 15,5 km de Osasco passava sem aviso nenhum, e meio quilômetro de diferença não é visível para quem registra. `findDistanceProximity()` mede todas as cidades do caso e devolve `bloqueios`, `alertas` e `proxima`; `findDistanceConflicts()` virou atalho para os bloqueios. Os três pontos de registro (`add_uso`, `add_uso_batch`, `bulk_preflight`) devolvem `warn_detalhes` estruturado, e o frontend troca a faixa inline e o `confirm()` do navegador por um modal dedicado (`showDistanceWarn()`), que mostra caso, cidade nova, de quem está perto, a distância medida e o limite aplicado.

O filtro de profissional ganhou o modo **"usam juntos"**. Com dois ou mais nomes, o padrão segue mostrando a união dos casos de cada um; no modo novo `matchesProfFilter()` exige que todos os nomes tenham correspondência no mesmo caso, que é como achar os poucos casos em comum entre dois clientes. Contadores, nota de escopo, chips de filtro ativo e o PDF do visualizador seguem o mesmo modo.

### v23.20 (2026-08-28)

**Correção: o profissional deixa de ser duplicado quando atua em mais de uma cidade do caso.** Registrando duas cidades para a mesma pessoa, a coluna de clientes ficava com o nome repetido ("FLÁVIA AMORIM/FLÁVIA AMORIM") enquanto a UF aparecia uma vez só.

As três colunas são listas independentes desde a v21.1, quando a UF passou a ser gravada como conjunto único e o alinhamento por índice entre elas deixou de valer (o `remove_item` remove um item sem tocar nas listas paralelas). O profissional tinha ficado de fora dessa regra: `add_uso` e `add_uso_batch` anexavam o nome a cada linha registrada.

Agora os dois caminhos passam pelo helper `profJaRegistrado()`, que compara ignorando caixa e espaços nas pontas, o mesmo critério da checagem de duplicidade do registro em massa. A grafia já gravada é preservada. Cidade continua entrando sempre, porque cidade repetida no caso já é barrada antes da escrita.

Casos gravados antes desta versão mantêm o nome repetido até serem editados.

### v23.19 (2026-08-28)

**Limpeza de cache de casos específicos, em lote.** A ação `clear_cache` passou a aceitar `caso_ids`, uma lista separada por vírgula, espaço ou quebra de linha, além do `caso_id` único e da limpeza global. Para cada ID ela apaga a linha em `thumb_cache` e as thumbnails físicas correspondentes; a listagem volta a ser lida do Drive na próxima abertura do caso.

O motivo é o TTL: `THUMB_CACHE_TTL` é de 30 dias. Quando um arquivo entra na pasta errada no Drive e depois é retirado de lá, o caso afetado continua exibindo a listagem antiga, e até aqui a correção era limpar caso a caso pelo painel ou zerar o cache da base inteira.

Dois pontos de entrada na interface, os dois com confirmação listando os IDs antes de executar:

- **Barra de seleção da grade**, botão "Limpar cache": age sobre os casos marcados.
- **Admin Mode**, card "Limpar cache de casos específicos": aceita a lista colada, com ou sem o prefixo `CASO-`, e informa quais IDs já estavam sem cache (útil para achar ID digitado errado).

Teto de `CLEAR_CACHE_MAX_IDS` (100) por chamada, porque cada caso limpo vira uma releitura no Drive na próxima visualização. A operação é registrada no `audit_log` como `clear_cache_batch`. O `folder_cache` fica de fora de propósito: é global e expira sozinho em `FOLDER_CACHE_TTL` (1 hora).

### v23.18 (2026-08-27)

**Seletor de versões antes do download em lote.** O botão "Baixar (ZIP)" passa por uma janela onde se escolhe o que entra no pacote, em três eixos: **logo** (sem logo, LH, EH, NA), **formato** (VNI, VOI, QNI, QOI e os equivalentes de vídeo) e **versão** (V1 em diante). Cada opção mostra quantos arquivos e quantos bytes acrescenta, e o rodapé mostra o total selecionado e quanto se economiza. Vêm marcados NA e os formatos normais (VNI/QNI); se o lote não tiver o que o padrão pede, marca tudo daquele eixo em vez de abrir vazio.

O motivo é peso: o mesmo par de fotos costuma existir em três marcas e dois enquadramentos. Na base PH, os arquivos com NA são cerca de um quarto do acervo, então o padrão corta perto de três quartos do download.

Novo endpoint `bulk_manifest` devolve o inventário classificado dos casos selecionados (sai do cache de fotos, é barato), e `download_bulk` passou a aceitar `file_ids` com a escolha do usuário, conferidos contra os arquivos dos casos pedidos.

**Classificação por token, não por sufixo.** A nomenclatura tem ordem livre: a base tem 423 arquivos `VNI-NA` e 165 `NA-VNI`, 333 `LH-QNI` e 19 `QNI-LH`. A classe `AssetName` quebra o nome em tokens e classifica um a um. Verificado contra os 4434 arquivos do acervo: apenas 6 (0,1%) ficam sem formato reconhecido.

Achados do levantamento que mudaram o desenho:

- O sufixo de formato é `[V|Q][N|O][I|V]`, não só `...I`: existem 44 `VNV` e 9 `VOV`, que são vídeo, não imagem.
- As versões vão até **V6**, não até V3, então o eixo é montado a partir do que existe.
- Um mesmo arquivo pode ter dois logos (`CASO-100-LH-NA-QNI.jpg`) e aparece nos dois filtros.
- Os tokens soltos `H-` (34) e `L-` (49) **não são `LH` truncado**: conferido nas imagens, esses arquivos não têm marca nenhuma, e a leitura como "sem logo" está correta. Token desconhecido não descarta o arquivo, só não contribui para nenhum eixo, então um `CASO-102-H-NA-QNI.jpg` ainda é lido como NA + QNI.
- Só imagem e vídeo entram no pacote. O acervo tem 3 `.prproj`, que ficam de fora do download.

### v23.17 (2026-08-27)

**Progresso em porcentagem no download em lote.** O `size` de cada arquivo passou a ser pedido na mesma listagem do Drive que já era feita, sem chamada extra. Com ele o backend calcula o tamanho **exato** do ZIP antes de começar (só é exato porque o pacote é "store": 30 bytes de cabeçalho local + nome + dados + 16 do data descriptor por entrada, mais 46 + nome no diretório central, mais 22 no fecho) e manda em `X-Zip-Total`. O frontend mostra barra, porcentagem, velocidade e tempo restante.

Vai num cabeçalho próprio e não em `Content-Length` de propósito: se um arquivo falhar no meio, o total real encolhe, e prometer um `Content-Length` que não se cumpre quebra a resposta. Assim a barra apenas não fecha em 100%.

Casos cacheados antes da mudança ganham os tamanhos por `fillMissingSizes()`, uma listagem por caso, gravada de volta no cache. Sem tamanho conhecido, o cabeçalho é omitido e o frontend cai no progresso por bytes recebidos.

### v23.16 (2026-08-27)

**Download em lote voltou a funcionar: o ZIP agora é escrito em fluxo.** Um lote de 8 casos passava de 100 s montando o pacote e o Cloudflare derrubava a requisição com **HTTP 524** antes de qualquer byte sair do servidor, então o usuário esperava dois minutos e não recebia nada. A causa não era volume de dados: era a ordem das operações.

O endpoint baixava todas as fotos do Drive, montava o ZIP inteiro em disco com `ZipArchive` e só então chamava `readfile()`. O primeiro byte da resposta só existia depois de tudo pronto, e é justamente esse tempo que o Cloudflare cronometra.

O que mudou:

- Novo `StreamingZip` em `handler.php`: escreve o pacote direto na resposta, arquivo a arquivo, conforme cada um chega do Drive. Usa "store" (sem compressão, já que JPEG e MP4 não comprimem) e *data descriptor* por entrada, que é o mecanismo do formato para escrita em fluxo quando o tamanho ainda não é conhecido. Verificado contra o Explorer do Windows, o `System.IO.Compression` do .NET e o `zipfile` do Python, com CRC conferido entrada por entrada.
- Novo `GoogleAPI::streamDriveFile()`: entrega os bytes em pedaços para um callback em vez de carregar o arquivo inteiro em memória, **dispensa a chamada de metadados** (quem chama em lote já tem o nome pela listagem, e essa viagem extra ao Google multiplicada por foto era boa parte da demora) e reaproveita a mesma conexão cURL entre arquivos, economizando um handshake TLS por foto.
- Sem mais temporários em disco e sem o lote inteiro em RAM: a memória fica no tamanho de um pedaço.
- Falha em um arquivo não contamina o pacote: a entrada é abandonada (não entra no diretório central, some do ZIP em vez de virar um JPEG de 0 byte) e o motivo é listado num `_ERROS.txt` dentro do próprio pacote, já que depois do primeiro byte não há como responder um JSON de erro.
- O overlay do frontend mostra bytes recebidos e velocidade, lendo o corpo da resposta em pedaços, no lugar do cronômetro que só contava segundos.

### v23.15 (2026-08-27)

**Registro em massa aceita vários locais por profissional.** Os dois modais (grade selecionada e "por ID") ganharam o botão **"+ Adicionar outro local"** e a lista de locais adicionados, espelhando o formulário do painel do caso: cada linha é um trio UF + cidade + profissional, e todos os casos selecionados recebem a lista inteira. Cobre o profissional que atua em mais de uma praça (Fortaleza-CE e Parnaíba-PI, Osasco-SP e Ubatuba-SP) sem precisar repetir o registro em massa uma vez por cidade.

Mudanças de apoio:

- `bulk_preflight` passou a aceitar `entries` (JSON array de trios), simulando a gravação linha a linha em cada caso: a segunda cidade do lote também é checada por distância contra a primeira. O formato antigo (`uf`/`cidade`/`profissional` soltos) continua aceito como uma única linha. O aviso de "estado já tem uso" sai uma vez por caso, não uma por linha.
- A gravação passou de N chamadas `add_uso` (uma por caso) para uma `add_uso_batch` por caso: uma escrita no Sheets por caso, mesmo com vários locais.
- Os dois modais voltam a funcionar depois de um registro. A tela de progresso substitui o `innerHTML` do modal; o formulário original agora é guardado na primeira abertura e restaurado nas seguintes, em vez de exigir reload da página.
- Validação da linha atual passou a se guiar pela cidade: depois de "Adicionar", UF e profissional continuam preenchidos de propósito e não disparam mais "linha atual incompleta". Cidade digitada mas não escolhida na lista agora é erro explícito, em vez de ser ignorada em silêncio. Mesmo ajuste no formulário do painel do caso.

### v23.14 (2026-08-07)

**Bloqueio passa a ter precedência sobre a praça no PDF de disponibilidade.** Um caso bloqueado agora entra sempre na segunda lista, tenha ou não uso registrado na praça — não está disponível em lugar nenhum. A lista foi renomeada de "Em uso em <praça>" para **"Indisponíveis em <praça>"**, que cobre os dois motivos sem distinguir qual é qual (informação interna). O modal mostra quantos dos indisponíveis vêm de bloqueio.

Com isso a classificação virou exaustiva: todo caso do profissional cai em exatamente uma das duas listas. Antes, a regra espelhava o `usoPredicate()` de `casos.js` — correta para a grade, onde "o bloqueio não apaga o uso" —, e o resultado era inconsistente: bloqueado fora da praça sumia do documento, bloqueado dentro da praça ia para "Em uso" com a foto, e o aviso de casos omitidos contava só os primeiros.

### v23.13 (2026-08-07)

**Qualidade das imagens no PDF de disponibilidade.** O modal passou a perguntar entre "Alta (~1600px)" — padrão, e reposta a cada abertura — e "Rápida (miniaturas)". Em alta as imagens vêm de `previewSrc()` (action `view_preview`), a mesma rendição do visualizador; a primeira geração materializa cada arquivo no servidor, então há uma fase de aquecimento com concorrência 4 antes de abrir a janela de impressão, para não disparar dezenas de downloads do Drive de uma vez. Em alta também entram fotos que ainda não têm miniatura no cache local, já que a rendição é gerada sob demanda.

Antes o exportador usava `preview_url || thumb_url`, e como `preview_url` só é preenchido quando o arquivo **já** está materializado (`file_exists` em `previewUrl()`), na prática caía quase sempre na miniatura — daí a baixa qualidade.

**Separação entre as listas.** Cada seção começa em página nova no impresso (`break-before: page`) e, na tela, ganha linha tracejada e respiro; o cabeçalho ficou maior, com régua e uma linha declarando o critério ("Nenhum uso registrado em SP." / "Já em uso em SP.").

### v23.12 (2026-08-07)

**PDF de disponibilidade por praça** (`assets/disponibilidade.js`). Com profissional e estado filtrados, o botão "📍 PDF de disponibilidade" gera um documento imprimível separando os casos do profissional em duas listas — livres e em uso na praça — e o usuário escolhe se leva as duas ou só uma. Serve ao cliente que vai passar a atuar em outro estado e precisa saber o que pode levar.

O recorte é o mesmo da grade em modo combinado (`filterScope()`): universo = casos do profissional; status = uso na praça, por qualquer profissional. Com cidade selecionada, a classificação é por cidade — que **ignora a regra de raio mínimo** (`DISTANCE_RADIUS_KM`), então um caso usado numa cidade vizinha aparece como livre e ainda assim é barrado no registro. Por estado não há esse risco.

O documento é cego a tudo que não seja o recorte: não sai nome de quem usa, cidade, outro estado nem motivo de bloqueio. A escolha da imagem por versão prioriza a variante **NA** (logo neutra); sem NA, cai em VNI, QNI, QOI; as variantes com logo de cliente (LH/EH/CL) são último recurso e disparam um aviso com os IDs afetados. Sobre o tratamento dos casos bloqueados, ver v23.14.

### v23

Resumo — detalhes em `DEPLOY.md`, seção "O que mudou na v23": segredos movidos para `secrets.local.php`; proteção CSRF em todas as ações POST; Cloudflare Turnstile opcional no login; gerador de hash `api/gerar-hash.php`; sincronização Drive↔planilha automática pelo cron + botão manual; `index.html` → `index.php` com cache busting automático e verificação de build (`APP_BUILD`); edição concorrente (lock otimista + aviso de presença); export com bibliotecas locais (gif.js, lame, ffmpeg.wasm).

### v21.2 (2026-05-18)

**Bugs corrigidos**
- Bump de `?v=24` → `?v=25` em todos os assets do `index.html`. Sem o incremento, o navegador continuava servindo o `admin.js` cacheado da v21.1, e os cliques nos botões novos disparavam `ReferenceError`.

**Novos recursos**
- **Auditoria de distâncias** (`audit_distances`): admin pode rodar uma varredura completa que detecta pares de cidades no mesmo caso já fora do raio mínimo. Espelha a validação que o formulário aplica, mas retroativamente sobre os dados existentes. Resultado por base, com coluna "Limite do par" e export `.txt`.
- **Cidades coringa**: cidades populosas onde o raio mínimo é menor que o padrão (ex.: São Paulo/SP a 25 km). Lista editável no painel admin com autocomplete IBGE (igual ao form de registro de uso). Storage em `private-config/distance_overrides.json` (gitignored). Backend recusa raio coringa maior que o padrão.
- **Regra `min` por par**: tanto no formulário quanto na auditoria, o raio efetivo de cada par de cidades é o **menor** entre os dois — uma cidade coringa "puxa" pra baixo qualquer par de que participe. Mensagens de conflito agora mostram o limite efetivo (ex.: `"Campinas/SP (40km, limite 25km)"`).
- **Raio padrão editável pelo admin**: `DISTANCE_RADIUS_KM` agora aceita override via `distance_config.json` (gravado pelo painel admin). O `config.php` lê esse arquivo no boot — não precisa mais editar PHP na mão pra ajustar o raio.

### v21.1 (2026-05-13)

**Bugs corrigidos**
- UF não é mais duplicada na escrita do Sheets (`SP/SP/RJ` → `SP/RJ`). Após o fix, ufs e cidades/clientes não estão mais alinhados por índice; warnings ficaram genéricos.
- Botão `🔄 Atualizar` na topbar: força refresh ignorando o cache MySQL (TTL 5 min). Necessário quando casos novos são adicionados na planilha ou arquivos novos no Drive não aparecem.
- Chip de UF voltou a aceitar remoção, com guarda: só pode marcar UF se ao menos uma cidade e um profissional já estiverem marcados para remoção.
- IDs duplicados no modal "Por ID" são deduplicados silenciosamente com aviso.

**Novos recursos**
- **Multi-row no formulário "Registrar uso"**: usuário pode adicionar várias linhas (UF/cidade/profissional) antes de submeter. Endpoint atômico `add_uso_batch` valida tudo antes; se uma linha falha, nada é gravado.
- **Tags canônicas (vocabulário controlado)**: admin gerencia a lista global em `private-config/tags.json` via nova seção em Admin Mode → Gerenciar tags. Usuários só podem aplicar tags que existem na lista. Remoção em cascata: ao apagar uma tag, ela some de todos os casos em todas as bases. Migração automática na primeira execução.
- **Validação por distância (Haversine)**: ao registrar uso, o backend verifica se há cidades em uso a menos de `DISTANCE_RADIUS_KM` (default 80) da nova cidade, no mesmo caso. Usuário comum é bloqueado; admin recebe warning e confirma. **(v23.21)** Entre o raio mínimo e o raio de atenção o registro passa, mas só depois de o usuário confirmar o aviso. CSV de coordenadas IBGE em `private-config/cidades_coords.csv`. Se o CSV não puder ser carregado, todo registro é bloqueado com erro explícito. **v21.2:** o raio por par passou a ser `min(raioA, raioB)` para acomodar cidades coringa (raio reduzido).
- **Atomicidade no Registro em massa**: novo endpoint `bulk_preflight` checa todos os casos selecionados ANTES de qualquer write. Se algum falha, nenhum é gravado.
- **Auditoria de qualidade dos dados** (`audit_data`): admin pode rodar uma varredura completa que identifica UFs inválidas, cidades não reconhecidas (com sugestões fuzzy por Levenshtein), cidades cadastradas em UF errada e duplicatas. Resultado exportável como `.txt`. Ferramenta principal pra limpar a planilha antes da validação por distância funcionar bem.

### v21 (2026-05-13)

**Correções de bugs**
- Popup de preview no modal "Registro por ID" passou de 120×120 para 240×240 com clamping de viewport.
- UF não é mais duplicada no painel quando há múltiplas cidades no mesmo estado.
- Tags com caracteres acentuados (`ESTÉTICA`, `BOTÓX`, etc.) preservam o acento — regex e `mb_strtoupper` no backend (`handler.php`, `google.php`) e no frontend (`addTagFromInput`).
- Chip de cidade com apóstrofo no nome (`ITAÚ D'OESTE`) não quebra mais o handler de click.
- Botão "Renovar sessão" mostra mensagem genérica em vez de "4h".
- `export/index.html`: download ZIP voltou a funcionar — removido o multi-CDN fallback e o JSZip foi hospedado localmente em `export/lib/jszip.min.js`.

**Segurança / robustez**
- `withJsonLock()` em `handler.php`: serializa leituras-modificações-escritas em `passwords.json`, `users_override.json`, `production_users.json`.
- `acquireCaseLock()` aplicado a `add_tag` e `remove_tag`.
- Rate limit de login redesenhado: chave `(usuário, dispositivo)` com cookie persistente `bi_device`, fallback `(usuário, IP)` para primeira tentativa. Coluna `ip` da tabela `login_attempts` expandida para VARCHAR(120).
- `SESSION_LIFETIME` reduzido de 4h para 2h (renew automático mantém usuários ativos).
- `CRON_KEY` agora aceito por header `X-Cron-Key` (preferido) ou GET (compat). Comparação `hash_equals`.
- Limite do endpoint `historico` aumentado de 500 para 100000.

**Arquitetura**
- Frontend dividido em `assets/`: dois arquivos CSS (`theme.css`, `app.css`) e oito JS (`utils.js`, `theme.js`, `casos.js`, `panel.js`, `bulk.js`, `admin.js`, `auth.js`, `app.js`).
- `index.html` reduzido para markup + `<link>`/`<script>` (de ~3000 linhas para ~330).
- Cache busting via `?v=NN` nas referências.

### v20 e anteriores

Ver histórico do repositório.

---

*Em caso de divergência entre esta documentação e o código, o código é a fonte canônica de verdade. Atualize este documento sempre que houver mudanças relevantes na arquitetura ou nos endpoints.*
