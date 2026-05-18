# Banco de Imagens — Documentação Técnica

Versão da aplicação: **v21.1** · Última revisão: 2026-05-13

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
├── UPGRADE-V21.md                         Tutorial dos próximos passos pós-deploy v21.
│
├── seu-dominio.com/   Document root público.
│   ├── index.html                         Markup principal (HTML + tags <link>/<script>).
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
│   │   ├── cron.php                       Cache warmer (CLI ou HTTP autenticado).
│   │   └── .htaccess                      Restrições de acesso.
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
| `DISTANCE_RADIUS_KM`    | Raio mínimo (km) entre uma cidade nova e qualquer já em uso no mesmo caso. Default: 80. Apenas admin pode prosseguir em caso de conflito. **v21.2:** o valor pode ser sobrescrito em runtime por `private-config/distance_config.json` (gravado pelo painel admin); cidades coringa (raio reduzido) em `distance_overrides.json` — em pares mistos vale `min(raioA, raioB)`. |

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
| `login`           | POST   | Autentica; aplica rate limiting por (usuário+dispositivo). Emite cookie `bi_device` em login bem-sucedido. |
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
| `add_uso`       | POST   | Registra uso (UF, cidade, profissional). Aplica lock otimista por caso. **v21.1:** UF não duplica no Sheets; check de distância (`DISTANCE_RADIUS_KM`). |
| `add_uso_batch` | POST   | **(v21.1)** Registro atômico de várias linhas no mesmo caso. Pré-flight valida tudo antes do write; nenhuma linha é gravada se houver erro. Payload: `entries` (JSON array). |
| `bulk_preflight`| POST   | **(v21.1)** Verifica em lote antes do registro em massa: cidade-block, bloqueio, distância. Devolve `errors[]` e `warns[]`. |
| `audit_data`    | GET    | **(v21.1, admin)** Varre todos os casos de todas as bases procurando UFs inválidas, cidades não reconhecidas pelo CSV (com sugestões fuzzy via Levenshtein), cidades cadastradas em UF errada e duplicatas com escritas diferentes. Usado pra limpar a planilha antes da validação por distância funcionar bem. |
| `audit_distances`     | GET    | **(v21.2, admin)** Simula a regra de raio mínimo sobre os casos existentes: aponta pares de cidades no mesmo caso a uma distância em linha reta menor ou igual ao raio efetivo do par (`min(raioA, raioB)`). |
| `get_distance_config` | GET    | **(v21.2, admin)** Retorna o `DISTANCE_RADIUS_KM` em vigor (lê o override de `distance_config.json` quando presente). |
| `set_distance_config` | POST   | **(v21.2, admin)** Grava o novo raio padrão em `distance_config.json` (faixa 1–5000 km). Vale a partir da próxima requisição. |
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
| `clear_cache`  | POST   | Limpa cache de um caso ou de toda a base; apaga thumbnails locais.       |
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
| `change_password`        | POST   | Atualiza senha em `passwords.json`.                        |
| `set_production_access`  | POST   | Concede ou revoga acesso à produção em `production_users.json`. |

### Downloads

| Ação              | Método | Conteúdo                                                                   |
|-------------------|:------:|----------------------------------------------------------------------------|
| `download_photo`  | GET    | Stream do arquivo individual do Drive.                                     |
| `download_bulk`   | POST   | ZIP com até 30 casos. Cada subpasta no ZIP corresponde ao identificador.   |

---

## 7. Frontend (assets modulares)

A partir da v21 o frontend foi dividido em módulos servidos pela pasta `assets/`. O `index.html` contém apenas o markup + as tags `<link>` e `<script>` referenciando os bundles. Cada referência leva o sufixo `?v=NN` (cache busting): ao alterar um arquivo, incremente o número.

### Ordem de carregamento

A ordem é significativa porque todos os arquivos compartilham o mesmo escopo global (sem `import/export`):

```
theme.css → app.css
↓
utils.js → theme.js → casos.js → panel.js → bulk.js → admin.js → auth.js → app.js
```

### Responsabilidades

| Arquivo     | Conteúdo                                                                                  |
|-------------|-------------------------------------------------------------------------------------------|
| `theme.css` | Variáveis CSS de light/dark, reset global.                                                |
| `app.css`   | Componentes, layout, modais, grade, lightbox, painel admin.                               |
| `utils.js`  | `api()`, `esc/cap/norm`, `showToast/showConfirm`, `renderDD/renderFormDD`, `lev`, `ESTADOS`, `populateEstados`, `togglePwd`, `buildProfAC`, `API`. |
| `theme.js`  | IIFE inicial (aplica tema salvo), `setTheme`, `updateThemeButtons`, `initFAB`, `openHelp`, `startTour`. |
| `casos.js`  | Estado da grade (`casos`, `filtered`, `page`, `mode`, `thumbCache`, etc.), `loadCasos`, `applyFilter`, `renderGrid`, filtros de UF/cidade/profissional/tags, paginação, `lazyLoadThumbs`. |
| `panel.js`  | `currentCaso`, `pendingRemovals`, `openModal`, `renderModalChips`, editor de tags, add/remove de uso, bloqueio/desbloqueio, `loadIBGE`. |
| `bulk.js`   | `selMode`, `selIds`, `bulkSelIds`, `bulkCities`, lightbox flutuante, `downloadBulkZip`, registro em massa por grid e por ID, `parseBulkIds`. |
| `admin.js`  | `adminModeVisible`, `thumbSourceMode`, painel administrativo, histórico/reversões, `runDiag`, gerenciamento de usuários e senhas, cache. |
| `auth.js`   | `currentBase`, `availableBases`, `userRole`, `doLogin/doLogout`, `selectBase/switchBase`, `checkSessionOnLoad`, banner de modo TESTE. |
| `app.js`    | `initApp()` + chamada inicial `checkSessionOnLoad()`. Carregado por último.               |

### Cache busting

Para forçar o browser a recarregar um asset alterado:

1. Edite o arquivo em `assets/`.
2. No `index.html`, troque `?v=21` por `?v=22` (ou o próximo número) nas linhas correspondentes.
3. Suba o `index.html` e o(s) asset(s) modificados.

Sem o incremento, alguns browsers/proxies servem a versão em cache por horas.

---

## 8. Cache e desempenho

A camada de cache é distribuída em três níveis:

1. **Memória do PHP (intra-request)** — token OAuth e leituras pontuais.
2. **MySQL (inter-request)** — `thumb_cache`, `folder_cache` e `sheet_cache`.
3. **Disco (filesystem)** — arquivos `*.jpg` e `*.webp` em `thumbs*`.

Ações que invalidam parcialmente o cache:

- Qualquer escrita em `updateCaso*` invalida `sheet_cache` da base ativa.
- `clear_cache` apaga as entradas de `thumb_cache` e os arquivos físicos correspondentes.
- O cache warmer (`api/cron.php`) percorre todas as bases e regenera o cache faltante.

O download das thumbnails é paralelizado por meio de stream contexts não-bloqueantes (`GoogleAPI::downloadThumbsBatch()`), reduzindo o tempo total de N×T para aproximadamente max(T).

---

## 9. Segurança

### Hardening estrutural

- A pasta `private-config/` reside fora do document root, tornando-se inacessível por HTTP independentemente do `.htaccess`.
- Os endpoints legados (`config/`, `api/db.php`, `api/google.php`) respondem com HTTP 410 (Gone).
- Sessões PHP são armazenadas em `private-config/sessions/`, com `samesite=Lax`, `httponly` e `secure` quando há HTTPS.

### Autenticação e autorização

- Senhas armazenadas como hashes bcrypt (`PASSWORD_DEFAULT`).
- Sobrescritas dinâmicas em `passwords.json` (senha) e `users_override.json` (usuários criados via interface).
- Controle de papéis: `admin` (acesso total) e `user` (limitado a bases visíveis).
- `production_users.json` libera bases de produção a usuários comuns.
- **Rate limiting v21** — chave por `(usuário, dispositivo)` em vez de IP único. O servidor emite um cookie `bi_device` (httpOnly, 2 anos) no primeiro login bem-sucedido; usuários sem cookie usam fallback `(usuário, IP)`. Isto evita que uma pessoa errando a senha bloqueie toda a empresa que compartilha o mesmo IP público.
- `session_regenerate_id()` no login bem-sucedido para prevenir session fixation.
- Sessão de **2 horas** (v21, antes 4h). Renovação automática mantém usuários ativos logados.

### Operações sensíveis

- `acquireCaseLock()` serializa escritas concorrentes no mesmo caso (timeout 10s).
- **v21:** `acquireCaseLock` agora cobre `add_tag` e `remove_tag` (antes só `add_uso`, `set_block`, `unblock_case`).
- **v21:** `withJsonLock()` serializa leituras-modificações-escritas nos arquivos `passwords.json`, `users_override.json`, `production_users.json` via `flock(LOCK_EX)`.
- A escrita em Sheets é tentada até três vezes com backoff linear.
- Nenhum admin pode alterar a senha ou remover outro admin via API.

### Proteções HTTP

- `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY` em todas as respostas JSON.
- `download_photo` e `download_bulk` removem esses cabeçalhos antes do stream binário.
- **v21:** `cron.php` agora prefere o header `X-Cron-Key` (não vaza em logs de acesso). Mantém `?key=` GET por compatibilidade. Comparação via `hash_equals` (timing-safe).

---

## 10. Operação e manutenção

### Cache warmer

O script `api/cron.php` percorre todas as bases configuradas e força a recriação dos thumbnails ausentes em disco.

- **CLI** (preferido): pode ser agendado como cron de sistema invocando `php api/cron.php`.
- **HTTP**: agora autenticado por header `X-Cron-Key: <CRON_KEY>`. O parâmetro `?key=` continua aceito para compatibilidade mas deve ser migrado.

```
# CLI (DreamHost)
/usr/local/php83/bin/php /home/SEU_USER/seu-dominio.com/api/cron.php

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
- **Validação por distância (Haversine)**: ao registrar uso, o backend verifica se há cidades em uso a menos de `DISTANCE_RADIUS_KM` (default 80) da nova cidade, no mesmo caso. Usuário comum é bloqueado; admin recebe warning e confirma. CSV de coordenadas IBGE em `private-config/cidades_coords.csv`. Se o CSV não puder ser carregado, todo registro é bloqueado com erro explícito. **v21.2:** o raio por par passou a ser `min(raioA, raioB)` para acomodar cidades coringa (raio reduzido).
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
