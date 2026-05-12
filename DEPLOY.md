# Deploy — Hardening completo: tudo o que é privado fora do site público


## O que mudou

Saíram do document root (pasta pública `dominio.com/`) e foram para `private-config/` (pasta irmã, fora do alcance do Apache):

| Tipo | De | Para |
|---|---|---|
| Configs e segredos | `adm.../config/config.php` etc. | `private-config/config.php` |
| Credenciais Google | `adm.../config/google-credentials.json` | `private-config/google-credentials.json` |
| Hash de senhas (overrides) | `adm.../config/passwords.json` | `private-config/passwords.json` |
| Cache de token Google | `adm.../config/.token_cache.json` | `private-config/.token_cache.json` |
| Bibliotecas PHP (DB) | `adm.../api/db.php` | `private-config/lib/db.php` |
| Bibliotecas PHP (Google) | `adm.../api/google.php` | `private-config/lib/google.php` |
| Pasta de sessões | `adm.../sessions/` | `private-config/sessions/` |

Continua público (porque precisa ser):
- `api/handler.php` (único endpoint do app)
- `api/cron.php` (cache warmer — chamado por URL ou CLI)
- `index.html`, `404.html`, `403.html`, `500.html`, `.htaccess`
- `thumbs/`, `thumbs-po/` (servidos como imagens via URL)

## Estrutura final no servidor (DreamHost)

```
/home/SEU_USUARIO/                                  ← raiz da conta
├── private-config/                                 ← PRIVADA — sobe via FTP
│   ├── config.php
│   ├── google-credentials.json
│   ├── passwords.json
│   ├── lib/
│   │   ├── db.php
│   │   └── google.php
│   └── sessions/                                   ← PHP escreve aqui
└── dominio.com/            ← PÚBLICA (document root)
    ├── .htaccess
    ├── 404.html  403.html  500.html
    ├── index.html
    ├── api/
    │   ├── handler.php
    │   ├── cron.php
    │   ├── db.php          ← stub 410 Gone (pode apagar do servidor)
    │   ├── google.php      ← stub 410 Gone (pode apagar do servidor)
    │   └── .htaccess       ← bloqueia .php que não seja handler/cron
    ├── thumbs/
    └── thumbs-po/
```

## Passos de deploy (ordem importa!)

### 1. Subir `private-config/` para FORA do site público

Via FTP/SFTP, faça upload da pasta `raizdosite/private-config/` para `/home/SEU_USUARIO/private-config/` — **ao lado** do domínio, NÃO dentro dele.

A pasta `private-config/sessions/` deve subir vazia (PHP cria os arquivos sozinho em runtime).

### 2. Definir permissões

```bash
chmod 700 ~/private-config
chmod 700 ~/private-config/sessions
chmod 700 ~/private-config/lib
chmod 600 ~/private-config/*.json
chmod 600 ~/private-config/config.php
chmod 600 ~/private-config/lib/*.php
```

### 3. Subir os arquivos atualizados do site público

- `dominio.com/.htaccess`
- `dominio.com/404.html`
- `dominio.com/403.html`
- `dominio.com/500.html`
- `dominio.com/api/handler.php`
- `dominio.com/api/cron.php`
- `dominio.com/api/.htaccess`
- (os stubs `api/db.php` e `api/google.php` podem subir, mas o ideal é apagá-los — passo 4)

---

> **A partir daqui o conteúdo é reconstituído.** Confira contra o que você lembra do original.

### 4. Limpar o legado no servidor

Apague do servidor qualquer arquivo que tenha sido movido para `private-config/`. Em particular:

- `adm.../config/` — a pasta inteira (config.php, google-credentials.json, passwords.json, .token_cache.json) já está em `private-config/`. Pode apagar tudo.
- `adm.../api/db.php` e `adm.../api/google.php` — depois de confirmar que tudo está funcionando, apague esses stubs. O `.htaccess` em `api/` já bloqueia o acesso, mas remover é mais higiênico.
- `adm.../sessions/` — apague essa pasta também. As sessões agora vivem em `private-config/sessions/`.

### 5. Testar

Acesse o domínio no navegador:

1. Página inicial deve carregar normalmente.
2. Login deve funcionar com qualquer usuário válido.
3. Liste casos de uma base — confirma que o Google Sheets está respondendo.
4. Clique em um caso e veja as fotos — confirma que o Drive está respondendo.
5. Acesse `/api/handler.php?action=diagnostico` (logado como admin) — verifica conexão com banco, credenciais, schema, cache.

### 6. Configurar o cron (cache warmer)

No painel do DreamHost (Goodies → Cron Jobs), crie um cron novo:

- **Comando:**
  ```
  /usr/local/php83/bin/php /home/SEU_USUARIO/dominio.com/api/cron.php
  ```
- **Frequência sugerida:** a cada 1 hora.

> Como alternativa via URL (caso prefira gatilho HTTP), use a `CRON_KEY` definida em `config.php`:
> ```
> curl https://dominio.com/api/cron.php?key=CRON_KEY_AQUI
> ```

### 7. Rollback (se algo quebrar)

Se algo der errado depois do deploy:

1. **Reverter `.htaccess`** — deixe o do `.htaccess` antigo de volta no document root.
2. **Reativar `config/` antigo** — caso ainda tenha cópia no servidor, restaure os arquivos lá.
3. **Olhar logs do PHP** — em `/home/SEU_USUARIO/logs/dominio.com/http/error.log` no DreamHost.
4. **Testar `diagnostico`** — endpoint em `api/handler.php?action=diagnostico` mostra exatamente onde está falhando (DB, credenciais, Google, cache).

## Checklist final

- [ ] `private-config/` subiu para `/home/SEU_USUARIO/private-config/`
- [ ] Permissões 700/600 aplicadas em `private-config/` e seu conteúdo
- [ ] `.htaccess` (root e `api/`) atualizados
- [ ] `handler.php` e `cron.php` atualizados em `api/`
- [ ] Stubs `api/db.php` e `api/google.php` apagados
- [ ] Pasta `config/` antiga apagada do document root
- [ ] Pasta `sessions/` antiga apagada do document root
- [ ] Login funciona
- [ ] Listagem de casos funciona
- [ ] Cron configurado
- [ ] `diagnostico` retorna OK em todas as seções
