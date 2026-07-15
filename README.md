# Banco de Imagens

Aplicação web para gerenciar e visualizar fotos de casos a partir de planilhas do Google Sheets e arquivos do Google Drive, com cache em MySQL para reduzir chamadas às APIs.

## O que faz

Centraliza, em uma única interface web, a consulta a múltiplas bases de casos (TESTE, produção etc.) que vivem em planilhas separadas do Google Sheets. Para cada caso, exibe as fotos correspondentes da pasta do Google Drive, gera thumbnails locais para acelerar a navegação e mantém um log de auditoria das ações dos usuários.

## Recursos principais

- Catálogo paginado de casos com thumbnails (proporção 4:5) e visualizador lightbox.
- Registro de uso por estado, cidade e profissional, com **validação por distância** (Haversine + dados do IBGE).
- Bloqueio de casos com motivo, gerenciamento de tags (vocabulário controlado pelo admin) e download em lote como ZIP.
- Histórico completo de auditoria com reversão por entrada ou por sessão de usuário.
- Múltiplas bases independentes (planilhas separadas, prefixos MySQL distintos) com permissões por papel.
- Painel admin com diagnóstico de conexão, gerenciamento de usuários, auditoria de qualidade dos dados e ferramenta de export.

## Stack

- **PHP 8.3** — backend sem framework, sem dependências externas.
- **MySQL** — cache de planilhas, thumbnails e log de auditoria.
- **Apache** — serve o site público; `.htaccess` bloqueia tudo que não é endpoint autorizado.
- **Google Sheets API + Google Drive API** — fonte primária dos dados.
- **HTML/CSS/JS puro** — frontend single-page modular em `dominio.com/assets/`.

## Arquitetura

```
private-config/                  ← FORA do document root (privada)
├── config.php                   constantes, bases, usuários (placeholders)
├── secrets.local.php            DB_PASS, CRON_KEY, Turnstile — NÃO versionado
├── google-credentials.json      service account do Google
├── passwords.json               overrides de senha
├── users_override.json          usuários criados via interface
├── production_users.json        mapa de acesso à produção
├── tags.json                    lista canônica de tags (admin)
├── cidades_coords.csv           coordenadas de municípios (IBGE)
├── lib/
│   ├── db.php                   conexão PDO + cache + audit
│   └── google.php               Sheets/Drive + JWT + thumbnails
└── sessions/                    gravadas pelo PHP em runtime

dominio.com/                     ← document root público
├── .htaccess                    hardening + páginas de erro
├── index.php                    markup principal + cache busting automático
├── ajuda.html                   documentação para o usuário final
├── 404.html / 403.html / 500.html
├── assets/                      módulos CSS e JS
│   ├── theme.css                tokens de tema (light/dark)
│   ├── app.css                  componentes, layout, modais
│   ├── utils.js                 helpers e cliente HTTP
│   ├── theme.js                 tema, FAB, tour
│   ├── auth.js                  login, sessão, seleção de base
│   ├── casos.js                 grid, filtros, thumbnails
│   ├── panel.js                 painel do caso, chips, tags
│   ├── bulk.js                  operações em lote, lightbox
│   ├── admin.js                 admin mode, histórico, auditoria
│   └── app.js                   bootstrap
├── api/
│   ├── handler.php              ÚNICO endpoint da API (JSON)
│   ├── cron.php                 cache warmer + sync Drive↔planilha
│   ├── gerar-hash.php           gerador de hash bcrypt (admin-only)
│   └── .htaccess                allowlist: só handler/cron/gerar-hash respondem
├── export/
│   ├── index.html               ferramenta de exportação client-side
│   └── lib/jszip.min.js         JSZip hospedado localmente
├── thumbs/                      cache de imagens (base produção)
└── thumbs-teste/                cache de imagens (base teste)
```

A separação `private-config/` × document root é o coração do hardening: tudo que tem segredo fica **fora** da pasta servida pelo Apache. Detalhes em `DEPLOY.md`.

## Segurança em camadas (resumo)

1. **Arquivos** — segredos fora do document root; allowlist de `.php` em `/api/`.
2. **Senhas** — apenas hashes bcrypt (`password_hash`/`password_verify`); nunca texto puro.
3. **Login** — rate limit por (usuário, dispositivo) + Cloudflare Turnstile opcional.
4. **Sessão** — cookie `httponly`/`samesite`, 2 h, `session_regenerate_id()` no login.
5. **CSRF** — token por sessão exigido em toda ação POST.
6. **Autorização** — papéis `admin`/`user` verificados no backend.
7. **Concorrência** — locks por caso e por JSON de configuração.
8. **Auditoria** — `audit_log` com snapshots e reversão.

Como cada camada funciona — o que é um hash bcrypt, onde as senhas vivem, a ordem de precedência e como trocar a senha de um admin — está no **capítulo 9 da [DOCUMENTACAO.md](DOCUMENTACAO.md)**.

## Como rodar (resumo)

1. Clonar este repositório.
2. Subir `private-config/` para um diretório **fora** do document root do seu servidor.
3. Subir `dominio.com/` (ou renomear para o caminho real do seu domínio) para o document root.
4. Preencher os valores reais em `private-config/config.php` nos lugares marcados com `SEU_*_AQUI` (hashes de usuários, IDs do Sheets/Drive) e criar `private-config/secrets.local.php` com `DB_PASS` e `CRON_KEY` (modelo em `DEPLOY.md`).
5. Substituir `private-config/google-credentials.json` pelo JSON real da conta de serviço do Google.
6. Aplicar permissões restritivas (700/600) em `private-config/`.
7. Acessar o domínio — o schema MySQL é criado automaticamente no primeiro hit.

Detalhes completos em [DEPLOY.md](DEPLOY.md).

## ⚠️ Importante — não commitar segredos

Os arquivos abaixo já estão sanitizados neste repositório (placeholders `SEU_*_AQUI`):

- `private-config/config.php` (DB password, hashes, IDs do Google, CRON_KEY)
- `private-config/google-credentials.json` (chave da service account)
- `private-config/passwords.json` (overrides de hash)
- `private-config/users_override.json` (usuários criados dinamicamente)

**NUNCA** comitar esses arquivos com valores reais. O `.gitignore` protege os JSONs sensíveis; o `config.php` permanece versionado mas sempre com placeholders. Antes de comitar uma mudança no `config.php`, troque os valores reais pelos placeholders novamente.

## Documentação

- [DOCUMENTACAO.md](DOCUMENTACAO.md) — referência técnica: arquitetura, API, modelo de dados e **segurança (cap. 9)**.
- [DEPLOY.md](DEPLOY.md) — passo a passo do deploy, hardening, Turnstile e cache busting.
- [private-config/LEIA-ME.txt](private-config/LEIA-ME.txt) — explicação da separação privada/pública.

## Licença

Defina sua licença aqui (MIT, Apache-2.0, ou outra).
