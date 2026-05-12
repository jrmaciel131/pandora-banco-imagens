# Banco de Imagens — Documentação Técnica

Versão da aplicação: **v20** · Última revisão: 2026-05-06

Esta documentação descreve a arquitetura, os componentes e os fluxos operacionais do sistema **Banco de Imagens**, uma aplicação web destinada à consulta, marcação e auditoria de uso de casos cadastrados em planilhas do Google Sheets, com as fotos hospedadas no Google Drive.

---

## Sumário

1. Visão geral
2. Arquitetura
3. Estrutura de diretórios
4. Configuração
5. Modelo de dados
6. API HTTP
7. Frontend
8. Cache e desempenho
9. Segurança
10. Operação e manutenção

---

## 1. Visão geral

A aplicação centraliza o controle dos casos cadastrados pela equipe, oferecendo:

- Catálogo paginado das fotos de cada caso, com geração de thumbnails locais.
- Registro do uso por estado, cidade e profissional.
- Bloqueio/desbloqueio de casos e gerenciamento de tags.
- Histórico completo de auditoria com possibilidade de reversão.
- Múltiplas bases independentes (TESTE, PH, PO) com permissões por usuário.
- Painel de diagnóstico, gerenciamento de usuários e exportação de casos.

A integração externa se dá com **Google Sheets** (fonte de verdade dos casos) e **Google Drive** (armazenamento das fotos), via conta de serviço autenticada por **JWT**.

---

## 2. Arquitetura

A aplicação adota uma arquitetura monolítica em PHP com frontend em HTML/CSS/JavaScript estáticos, persistindo o estado em **MySQL** e em arquivos JSON na pasta privada. Todos os dados sensíveis residem fora do document root.

```
┌──────────────────────┐        ┌─────────────────────┐
│   Frontend (HTML)    │  AJAX  │  api/handler.php    │
│  index.html / export │ ──────►│  (front controller) │
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
├── dominio.com/   Document root público.
│   ├── index.html                         SPA principal (login + grade + modal).
│   ├── ajuda.html                         Documentação interna em formato de tutorial.
│   ├── 403.html / 404.html / 500.html     Páginas de erro com redirect automático.
│   ├── api/
│   │   ├── handler.php                    Front controller da API JSON.
│   │   ├── cron.php                       Cache warmer (CLI ou HTTP autenticado).
│   │   ├── db.php / google.php            Stubs HTTP 410 para versões legadas.
│   │   └── .htaccess                      Restrições de acesso.
│   ├── config/                            Pasta legada (apenas stub HTTP 410).
│   ├── export/index.html                  Ferramenta de exportação de casos.
│   ├── thumbs/                            Cache de thumbnails da base PH (vazia).
│   ├── thumbs-po/                         Cache de thumbnails da base PO (vazia).
│   ├── thumbs-teste/                      Cache de thumbnails da base TESTE (vazia).
│   ├── sessions/                          Pasta legada de sessões (HTTP 410).
│   └── favicon.ico, favicon.gif
│
└── private-config/                        Pasta privada (fora do document root).
    ├── config.php                         Constantes globais e definição das bases.
    ├── google-credentials.json            Credenciais da conta de serviço Google.
    ├── passwords.json                     Sobrescritas dinâmicas de senhas.
    ├── production_users.json              Mapa de usuários com acesso à produção.
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
| `SESSION_LIFETIME`      | Duração da sessão (s).                                                    |
| `SESSION_WARN_BEFORE`   | Antecedência (s) para o aviso de expiração.                               |
| `MAX_LOGIN_ATTEMPTS`    | Tentativas antes do bloqueio de IP.                                       |
| `LOGIN_BLOCK_MINUTES`   | Duração do bloqueio (min).                                                |
| `CRON_KEY`              | Chave necessária para invocar o cache warmer via HTTP.                    |

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
| `login_attempts`  | Contagem de falhas e bloqueios temporários por IP.                        |

A criação é idempotente em `DB::setup()`, executado no bootstrap do `handler.php` e do `cron.php` para todas as bases configuradas.

### Caso (linha da planilha)

A planilha possui as colunas **A:G** lidas pela aplicação:

| Coluna | Conteúdo                                                  |
|:------:|-----------------------------------------------------------|
| A      | Reservada (não usada).                                    |
| B      | Identificador do caso (`CASO-<n>`).                       |
| C      | UFs separadas por `/` ou `-`. Marcadores `NA` ou `LINDA` indicam bloqueio. |
| D      | Cidades (separadas por `/`).                              |
| E      | Clientes/Profissionais (separados por `/`).               |
| F      | Tags (separadas por `/` ou `,`, normalizadas em maiúsculas). |
| G      | Motivo do bloqueio (texto livre).                         |

---

## 6. API HTTP

Todas as requisições são despachadas pelo front controller `api/handler.php`. O endpoint usa o parâmetro `action` (GET ou POST) para distinguir a operação. Salvo nos endpoints de download binário, a resposta é sempre `application/json` com o contrato `{ ok: bool, ... }`.

### Sessão e autenticação

| Ação              | Método | Descrição                                                            |
|-------------------|:------:|----------------------------------------------------------------------|
| `login`           | POST   | Autentica usuário/senha; aplica rate limiting por IP.                |
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
| `add_uso`       | POST   | Registra uso (UF, cidade, profissional). Aplica lock otimista por caso.                |
| `remove_uso`    | POST   | Remove uma entrada inteira por índice.                                                 |
| `remove_item`   | POST   | Remove uma única UF, cidade ou cliente, opcionalmente por índice.                      |
| `set_block`     | POST   | Bloqueia caso adicionando o marcador `NA` e gravando o motivo.                         |
| `unblock_case`  | POST   | Remove os marcadores e o motivo (admin).                                               |
| `add_tag`       | POST   | Acrescenta tag ao caso (máx. 30 caracteres, 20 tags por caso).                         |
| `remove_tag`    | POST   | Remove tag (idempotente).                                                              |
| `list_tags`     | GET    | Lista de tags únicas em todos os casos (autocomplete).                                 |

### Histórico e reversões

| Ação            | Método | Descrição                                                              |
|-----------------|:------:|------------------------------------------------------------------------|
| `historico`     | GET    | Lista de entradas do `audit_log`, com filtros opcionais.               |
| `revert_caso`   | POST   | Reaplica um snapshot anterior (admin).                                 |

### Cache

| Ação           | Método | Descrição                                                                |
|----------------|:------:|--------------------------------------------------------------------------|
| `clear_cache`  | POST   | Limpa cache de um caso ou de toda a base; apaga thumbnails locais.       |
| `speed_test`   | GET    | Compara o tempo de resposta entre Drive e cache local (admin).           |
| `diagnostico`  | GET    | Health-check completo do ambiente (admin).                               |
| `test_log`     | GET    | Diagnóstico do `audit_log`: grava e relê uma entrada.                    |

### Usuários (admin)

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

## 7. Frontend

A aplicação principal vive em um único arquivo HTML (`dominio.com/index.html`) e adota uma SPA simples sem framework, mantendo todas as visões (login, grade, modal de caso, painel admin, histórico) em um mesmo documento.

Principais aspectos:

- Tema claro/escuro com `prefers-color-scheme` e override manual via `data-theme`.
- Grade densa em 6 colunas (cards 4:5), responsiva até 3 colunas em telas estreitas.
- Lazy loading de thumbnails com cancelamento por geração e priorização do card aberto.
- Modal de caso com edição de UFs, cidades, clientes e tags, e lightbox flutuante para fotos.
- Painel administrativo com diagnóstico de ambiente, gerenciamento de usuários, métricas e troca de base.
- Painel de histórico com agrupamento por sessão e reversão de operações individuais ou em lote.
- Ferramenta de exportação dedicada em `/export/index.html`.

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

- Senhas são armazenadas como hashes bcrypt (`PASSWORD_DEFAULT`).
- Sobrescritas dinâmicas em `passwords.json` (senha) e `users_override.json` (usuários criados via interface).
- Controle de papéis: `admin` (acesso total) e `user` (limitado a bases visíveis).
- `production_users.json` libera bases de produção a usuários comuns.
- Rate limiting por IP em falhas de login (`login_attempts`).
- `session_regenerate_id()` no login bem-sucedido para prevenir session fixation.

### Operações sensíveis

- `acquireCaseLock()` previne escritas concorrentes ao mesmo caso por até 10 segundos.
- A escrita em `Sheets` é tentada até três vezes com backoff linear.
- Nenhum admin pode alterar a senha ou remover outro admin via API.

### Proteções HTTP

- `X-Content-Type-Options: nosniff` e `X-Frame-Options: DENY` em todas as respostas JSON.
- `download_photo` e `download_bulk` removem esses cabeçalhos antes do stream binário.

---

## 10. Operação e manutenção

### Cache warmer

O script `api/cron.php` percorre todas as bases configuradas e força a recriação dos thumbnails ausentes em disco.

- Em modo CLI: pode ser agendado como cron de sistema invocando `php api/cron.php`.
- Em modo HTTP: requer o parâmetro `?key=<CRON_KEY>` para autenticar a invocação.
- A saída é transmitida em streaming (`text/plain`) quando chamado por HTTP.

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

*Em caso de divergência entre esta documentação e o código, o código é a fonte canônica de verdade. Atualize este documento sempre que houver mudanças relevantes na arquitetura ou nos endpoints.*
