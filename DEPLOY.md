# Deploy — Banco de Imagens v21

## O que mudou na v21

- **Frontend modular**: o `index.html` antes monolítico (≈3000 linhas) foi dividido em `assets/` com dois arquivos CSS e oito JS.
- **Hardening**: locks em escritas concorrentes (tags e JSONs de configuração), rate-limit por dispositivo, CRON_KEY via header, sessão de 2h.
- **Export ZIP**: JSZip agora hospedado localmente em `export/lib/jszip.min.js` (sem dependência de CDN).
- **v21.2:** novas ferramentas no painel admin (auditoria de distâncias, cidades coringa, raio editável). `config.php` ganhou bloco que lê override de `distance_config.json`. Cache busting bumpado para `?v=25`.

## Estrutura final no servidor (DreamHost)

```
/home/SEU_USUARIO/                                  ← raiz da conta
├── private-config/                                 ← PRIVADA (sobe via SFTP)
│   ├── config.php
│   ├── google-credentials.json
│   ├── passwords.json
│   ├── users_override.json
│   ├── production_users.json
│   ├── cidades_coords.csv                          ← (v21.1) CSV IBGE de coordenadas
│   ├── tags.json                                   ← runtime: NÃO sobrescrever no deploy
│   ├── distance_config.json                        ← (v21.2) runtime: NÃO sobrescrever
│   ├── distance_overrides.json                     ← (v21.2) runtime: NÃO sobrescrever
│   ├── lib/
│   │   ├── db.php
│   │   └── google.php
│   └── sessions/                                   ← PHP escreve aqui
└── seu-dominio.com/            ← PÚBLICA (document root)
    ├── .htaccess
    ├── 404.html  403.html  500.html
    ├── index.html
    ├── assets/                                     ← NOVO (v21)
    │   ├── theme.css   app.css
    │   ├── utils.js    theme.js   casos.js   panel.js
    │   ├── bulk.js     admin.js   auth.js    app.js
    ├── api/
    │   ├── handler.php
    │   ├── cron.php
    │   └── .htaccess
    ├── export/
    │   ├── index.html
    │   └── lib/
    │       └── jszip.min.js                        ← NOVO (v21)
    ├── thumbs/      thumbs-po/      thumbs-teste/
    └── favicon.ico  favicon.gif
```

## Passos de deploy (ordem importa)

### 1. Subir `private-config/` para FORA do site público

Via SFTP, faça upload de `raizdosite/private-config/` para `/home/SEU_USUARIO/private-config/` — ao lado do domínio, NÃO dentro dele. Se a pasta já existe (deploy v20+), basta sobrescrever **apenas estes arquivos**:

- `private-config/config.php`
- `private-config/lib/db.php`
- `private-config/lib/google.php`

**NÃO sobrescrever os arquivos de runtime** — eles guardam estado gerenciado pela aplicação:

- `private-config/sessions/` (sessões PHP ativas)
- `private-config/tags.json` (tags canônicas — v21.1)
- `private-config/distance_config.json` (raio padrão editado pelo admin — v21.2)
- `private-config/distance_overrides.json` (cidades coringa — v21.2)
- `private-config/passwords.json`, `users_override.json`, `production_users.json` (senhas e papéis trocados pelo admin)
- `private-config/.token_cache.json` (token OAuth cacheado)
- `private-config/cidades_coords.csv` (sobe **apenas uma vez** na v21.1; depois fica fixo)

### 2. Permissões

```bash
chmod 700 ~/private-config
chmod 700 ~/private-config/sessions
chmod 700 ~/private-config/lib
chmod 600 ~/private-config/*.json
chmod 600 ~/private-config/config.php
chmod 600 ~/private-config/lib/*.php
```

### 3. Subir o site público

Substitua/crie no servidor:

- `adm.../index.html` (versão enxuta, ~330 linhas)
- `adm.../assets/` **(pasta nova — criar)**
  - `theme.css`, `app.css`
  - `utils.js`, `theme.js`, `casos.js`, `panel.js`
  - `bulk.js`, `admin.js`, `auth.js`, `app.js`
- `adm.../api/handler.php`
- `adm.../api/cron.php`
- `adm.../export/index.html`
- `adm.../export/lib/jszip.min.js` **(arquivo novo — 97KB)**

Os arquivos `.htaccess`, páginas de erro e thumbnails existentes ficam.

### 4. Verificações pós-deploy

1. Abra o domínio no navegador (modo anônimo para não pegar cache antigo).
2. Login deve carregar sem flash de "Verificando sessão..." indefinido.
3. Liste casos — confirma Sheets + cache.
4. Abra um caso → veja fotos no painel — confirma Drive.
5. Modal "📋 Por ID" → preview de chips em 240×240.
6. Criar uma tag com acento (ex.: `ESTÉTICA`) — deve salvar preservando o acento.
7. Em `/export/`, baixar tudo como ZIP — deve funcionar sem CDN.
8. Como admin, abra `Admin Mode → Diagnóstico` e confirme todas as seções OK.

### 5. Configurar/atualizar o cron

**CLI (recomendado)** — sem mudança em relação à v20:

```
/usr/local/php83/bin/php /home/SEU_USER/seu-dominio.com/api/cron.php
```

**HTTP — preferir header (novo na v21)**:

```
curl -s -H "X-Cron-Key: SEU_CRON_KEY" https://seu-site.com/api/cron.php
```

O método antigo `?key=...` continua funcionando, mas vaza a chave em logs de acesso.

### 6. Rollback

Se algo der errado:

1. Restaurar o `index.html` antigo (monolítico) — preserva todo o app funcionando como na v20.
2. Olhar `~/logs/seu-dominio.com/http/error.log`.
3. Testar `api/handler.php?action=diagnostico` (admin) — aponta onde está falhando.
4. Para problemas no rate-limit: `DELETE FROM login_attempts;` no MySQL libera todos os bloqueios.

## Cache busting

A partir da v21, as referências em `index.html` levam sufixo `?v=N`. Versão atual: **`?v=25`** (v21.2). Quando alterar qualquer arquivo em `assets/`:

1. Edite o arquivo.
2. No `index.html`, incremente o número (ex.: `?v=25` → `?v=26`).
3. Suba `index.html` + o(s) asset(s) alterado(s).

Sem o incremento, os browsers podem servir o asset antigo do cache por horas. Foi exatamente isso que aconteceu no rollout da v21.2 — o `admin.js` cacheado da v21.1 disparou `ReferenceError` ao clicar nos botões novos.

> **Próximo passo opcional:** renomear `index.html` → `index.php` e usar `filemtime()` pra gerar o `?v=` automaticamente. Elimina a necessidade de bumpar manualmente.

## Checklist final

- [ ] `private-config/config.php`, `lib/db.php`, `lib/google.php` atualizados
- [ ] Permissões 700/600 mantidas em `private-config/`
- [ ] `adm.../index.html` substituído (versão modular)
- [ ] Pasta `adm.../assets/` criada com 10 arquivos (2 CSS + 8 JS)
- [ ] `adm.../api/handler.php` e `cron.php` atualizados
- [ ] `adm.../export/index.html` atualizado
- [ ] Pasta `adm.../export/lib/` criada com `jszip.min.js`
- [ ] Login funciona
- [ ] Tags com acento salvam corretamente
- [ ] Export ZIP funciona
- [ ] Cron configurado
- [ ] `diagnostico` retorna OK em todas as seções
