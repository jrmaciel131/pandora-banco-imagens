# Banco de Imagens — Projeto PANDORA

Aplicação interna para gerenciar e visualizar fotos de casos a partir de planilhas do Google Sheets e arquivos do Google Drive, com cache em MySQL para reduzir chamadas às APIs.

## O que faz

Centraliza, em uma única interface web, a consulta a múltiplas bases de casos (PH, PO, TESTE) que vivem em planilhas separadas do Google Sheets. Para cada caso, exibe as fotos correspondentes da pasta do Google Drive, gera thumbnails locais para acelerar a navegação e mantém um log de auditoria das ações dos usuários.

## Stack

- **PHP 8.3** — backend (sem framework, sem dependências externas).
- **MySQL** — cache de planilhas, thumbnails e log de auditoria.
- **Apache** — serve o site público; bloqueia tudo que não for endpoint autorizado via `.htaccess`.
- **Google Sheets API + Google Drive API** — fonte primária dos dados.
- **HTML/CSS/JS puro** — frontend single-page em `index.html`.

## Arquitetura

```
private-config/                ← FORA do document root no servidor
├── config.php                 credenciais, lista de bases, hashes
├── google-credentials.json    service account do Google
├── passwords.json             overrides de senha
├── users_override.json        overrides dinâmicos de usuários
├── production_users.json      autorizações para bases de produção
├── lib/
│   ├── db.php                 conexão PDO + cache + audit
│   └── google.php             Sheets/Drive + JWT + thumbnails
└── sessions/                  gravadas pelo PHP em runtime

dominio.com/                   ← document root público
├── .htaccess                  hardening + páginas de erro
├── index.html                 SPA do banco de imagens
├── ajuda.html                 documentação para o usuário final
├── 404.html / 403.html / 500.html
├── agents.txt / robots.txt    políticas para bots
├── api/
│   ├── handler.php            ÚNICO endpoint da API (JSON)
│   ├── cron.php               cache warmer (CLI ou URL com chave)
│   └── .htaccess              bloqueia .php que não seja handler/cron
├── thumbs/                    cache de imagens (PH)
└── thumbs-po/                 cache de imagens (PO)
```

A separação `private-config/` × document root é o coração do hardening: tudo que tem segredo fica **fora** da pasta servida pelo Apache, então não há como acessar via HTTP.

## Como rodar (resumo)

1. Subir a pasta `private-config/` para fora do document root no servidor.
2. Subir `dominio.com/` (ou o nome real do domínio) para o document root.
3. No `private-config/config.php`, preencher os valores reais nos lugares marcados com `..._AQUI` (DB, hashes de usuários, IDs do Sheets/Drive, CRON_KEY).
4. Substituir o `private-config/google-credentials.json` pelo JSON real da service account do Google.
5. Aplicar permissões restritivas (700/600) em `private-config/`.
6. Acessar o domínio — o schema MySQL é criado automaticamente no primeiro hit.

## ⚠️ Atenção — segredos

Os arquivos abaixo, **neste repositório**, estão com placeholders:

- `private-config/config.php`
- `private-config/google-credentials.json`
- `private-config/passwords.json`
- `private-config/users_override.json`

**NUNCA** comitar esses arquivos com valores reais.
