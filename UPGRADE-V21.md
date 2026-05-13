# Tutorial — Implantação da v21.1

> Esta é a versão atualizada incluindo os fixes adicionais (dedup de UF na escrita, botão de refresh forçado, multi-row form, tags canônicas, trava por distância 80km, atomicidade no registro em massa). Substitui a versão inicial da v21.

Este guia substitui a explicação solta no chat. Use-o passo a passo na hora de subir a v21 no servidor (DreamHost).

> **Antes de começar**: tenha um cliente SFTP (FileZilla, WinSCP, Cyberduck) configurado com a conta da DreamHost. Os caminhos abaixo usam `SEU_USUARIO` — substitua pelo seu login real do servidor.

---

## Parte 1 — O que vai subir

A v21 toca em 12 caminhos. Dá pra subir em qualquer ordem desde que **todos sejam atualizados antes de testar**.

### A. Fora do document root (`private-config/`)

| Arquivo local | Caminho no servidor |
|---|---|
| `raizdosite/private-config/config.php` | `/home/SEU_USUARIO/private-config/config.php` |
| `raizdosite/private-config/lib/db.php` | `/home/SEU_USUARIO/private-config/lib/db.php` |
| `raizdosite/private-config/lib/google.php` | `/home/SEU_USUARIO/private-config/lib/google.php` |
| **`raizdosite/private-config/cidades_coords.csv`** (NOVO) | `/home/SEU_USUARIO/private-config/cidades_coords.csv` |

> Atenção: a partir da v21.1 o `cidades_coords.csv` é **obrigatório** — sem ele o sistema bloqueia todo registro de uso com erro de "validação geográfica indisponível".

### B. Dentro do document root (`seu-dominio.com/`)

| Arquivo local | Caminho no servidor |
|---|---|
| `raizdosite/dominio.com/index.html` | `seu-dominio.com/index.html` |
| `raizdosite/dominio.com/api/handler.php` | `seu-dominio.com/api/handler.php` |
| `raizdosite/dominio.com/api/cron.php` | `seu-dominio.com/api/cron.php` |
| `raizdosite/dominio.com/export/index.html` | `seu-dominio.com/export/index.html` |

### C. Pastas e arquivos novos (criar)

| Caminho local | Caminho no servidor |
|---|---|
| `raizdosite/dominio.com/assets/theme.css` | `seu-dominio.com/assets/theme.css` |
| `raizdosite/dominio.com/assets/app.css` | `seu-dominio.com/assets/app.css` |
| `raizdosite/dominio.com/assets/utils.js` | `seu-dominio.com/assets/utils.js` |
| `raizdosite/dominio.com/assets/theme.js` | `seu-dominio.com/assets/theme.js` |
| `raizdosite/dominio.com/assets/auth.js` | `seu-dominio.com/assets/auth.js` |
| `raizdosite/dominio.com/assets/casos.js` | `seu-dominio.com/assets/casos.js` |
| `raizdosite/dominio.com/assets/panel.js` | `seu-dominio.com/assets/panel.js` |
| `raizdosite/dominio.com/assets/bulk.js` | `seu-dominio.com/assets/bulk.js` |
| `raizdosite/dominio.com/assets/admin.js` | `seu-dominio.com/assets/admin.js` |
| `raizdosite/dominio.com/assets/app.js` | `seu-dominio.com/assets/app.js` |
| `raizdosite/dominio.com/export/lib/jszip.min.js` | `seu-dominio.com/export/lib/jszip.min.js` |

**Total**: 3 arquivos privados + 7 arquivos públicos atualizados + 11 arquivos novos = **21 arquivos**.

---

## Parte 2 — Procedimento recomendado

### 1. Backup rápido (1 min)

Antes de subir qualquer coisa, baixe via SFTP (ou copie no painel da DreamHost) uma cópia destes 4 arquivos do servidor, caso precise reverter:

- `seu-dominio.com/index.html`
- `seu-dominio.com/api/handler.php`
- `seu-dominio.com/api/cron.php`
- `seu-dominio.com/export/index.html`

Salve em uma pasta `_backup-v20/` no seu computador.

### 2. Subir os privados primeiro (`private-config/`)

Conecte no SFTP e navegue até `/home/SEU_USUARIO/private-config/`. Substitua:

- `config.php` (mudou `SESSION_LIFETIME` para 7200)
- `lib/db.php` (mudou a tabela `login_attempts` — migração roda sozinha)
- `lib/google.php` (mudou leitura de tags para `mb_strtoupper`)

**Confira as permissões depois do upload**:

```
private-config/         → 700
private-config/lib/     → 700
private-config/*.php    → 600
private-config/lib/*.php → 600
```

No FileZilla: clique direito → "File permissions" → marque os valores numéricos.

### 3. Criar a pasta `assets/` no document root

Dentro de `seu-dominio.com/`, **crie a pasta `assets/`** (ela não existia antes). Mande os 10 arquivos:

```
assets/
├── theme.css
├── app.css
├── utils.js
├── theme.js
├── auth.js
├── casos.js
├── panel.js
├── bulk.js
├── admin.js
└── app.js
```

### 4. Criar a pasta `export/lib/`

Dentro de `seu-dominio.com/export/`, **crie a pasta `lib/`** e suba `jszip.min.js` dentro dela.

### 5. Atualizar os arquivos públicos

Substitua no servidor:

- `index.html` (drasticamente menor agora — só ~330 linhas)
- `api/handler.php`
- `api/cron.php`
- `export/index.html`

### 6. Testar IMEDIATAMENTE

Abra o site em uma **aba anônima** (incógnito) — isso garante que o browser não vai servir cache antigo.

| O que testar | Resultado esperado |
|---|---|
| Página carrega | Tela de "Verificando sessão..." some em até 3s |
| Login | Funciona normalmente |
| Listar casos | Aparecem normalmente |
| Abrir um caso | Modal abre com fotos, tags, chips |
| Criar tag `ESTÉTICA` | Salva com acento; aparece como `ESTÉTICA` (não `ESTTICA`) |
| Modal "📋 Por ID" | Cole alguns IDs, passe o mouse sobre os chips → preview em 240×240 |
| Caso com 2 cidades no mesmo estado | "Estados em uso" mostra a UF UMA vez só, sem `×` |
| `/export/` → Baixar tudo como ZIP | Funciona (sem erro de CDN) |
| Admin Mode → Diagnóstico | Todas as seções OK |

### 7. Migrar o cron para header (opcional)

Se você roda o cron por URL (`?key=...`) na DreamHost, **migre para header** quando puder. Edite o cron job:

**Antes:**
```
curl -s "https://seu-site.com/api/cron.php?key=SEU_CRON_KEY"
```

**Depois:**
```
curl -s -H "X-Cron-Key: SEU_CRON_KEY" https://seu-site.com/api/cron.php
```

A versão antiga continua funcionando — não é urgente.

Se você roda por CLI (`php /caminho/cron.php`), não muda nada.

---

## Parte 3 — Como atualizar JS/CSS no futuro (cache busting)

A partir desta versão, cada referência em `index.html` carrega um sufixo de versão:

```html
<link rel="stylesheet" href="assets/theme.css?v=21">
<script src="assets/utils.js?v=21"></script>
```

O `?v=21` força o browser a reconhecer o arquivo como "novo" e baixar de novo. Sem isso, browsers e CDNs podem servir o asset antigo do cache por horas.

### Quando alterar um asset

1. Edite o arquivo em `assets/` (ex.: `panel.js`).
2. Abra `index.html` e encontre a linha:
   ```html
   <script src="assets/panel.js?v=21"></script>
   ```
3. Incremente o número:
   ```html
   <script src="assets/panel.js?v=22"></script>
   ```
4. Suba `index.html` + `panel.js`.

### Regra prática

- **Mudou um arquivo** → incrementa só essa referência.
- **Mudou vários arquivos** → incrementa todas as referências afetadas (ou todas, se preferir simplificar).
- **Não esqueça o `index.html`** — ele precisa subir junto pra o browser ver a nova versão.

> Dica: você pode usar a mesma versão pra todos os assets (subir tudo como `?v=22`) — assim você só precisa lembrar de "incrementar 1" a cada deploy.

---

## Parte 4 — Rollback (se quebrar)

Se alguma coisa der errado depois do deploy:

### Rollback rápido (1 minuto)

1. Restaure o `index.html` antigo do `_backup-v20/`.
2. Pronto — todo o JS/CSS está dentro do HTML antigo, então ele funciona sozinho.
3. (Opcional) Restaurar os outros 3 PHPs também.

### Investigar

1. Abra `~/logs/seu-dominio.com/http/error.log` na DreamHost.
2. Acesse `api/handler.php?action=diagnostico` logado como admin — mostra exatamente qual seção falhou.
3. Se o problema é rate-limit (usuário bloqueado por engano), conecte no MySQL e rode:
   ```sql
   DELETE FROM login_attempts;
   DELETE FROM po_login_attempts;
   DELETE FROM teste_login_attempts;
   ```

---

## Parte 5 — O que vem depois da v21.1

Pendências discutidas mas ainda não implementadas:

- **CSRF tokens** (proteção contra requisições maliciosas de outros sites).
- **`download_bulk` em streaming** (atualmente carrega tudo na memória).
- **Senha do MySQL mais forte** (usar algo com 20+ chars aleatórios em vez de senhas curtas/previsíveis).
- **Move-out do OneDrive** (o projeto local sincroniza com OneDrive — credenciais expostas).

Quando for implementar algum desses, abrir nova conversa explicando o item e pedindo o fix.

## Parte 6 — Mudanças específicas da v21.1

Em cima da v21 original, foram adicionados:

### Pré-deploy

1. **`cidades_coords.csv`** (NOVO) — sobe em `private-config/`. ~390KB, contém latitude/longitude de todos os ~5570 municípios brasileiros (fonte: IBGE via projeto open-source kelvins/municipios-brasileiros). **Sem este arquivo, todo registro de uso é bloqueado** — o backend retorna "validação geográfica indisponível".
2. **`tags.json`** (NÃO precisa subir) — criado automaticamente na primeira chamada de `Admin Mode → Gerenciar tags`. Migração inicial coleta as tags já em uso nos casos e usa como ponto de partida.

### Pós-deploy — primeiras ações do admin

**1. Auditar a planilha existente** (antes de qualquer outra coisa)

A validação por distância só funciona se os nomes de cidades na planilha baterem com o CSV oficial do IBGE. Se você tem cidades escritas como `S.Paulo`, `Sao Paullo`, `Brasília-DF`, a validação ignora silenciosamente — e o sistema fica mais permissivo do que deveria.

- Logar como admin
- Ir em **Mais ▾ → Admin Mode → 🔍 Auditoria de dados**
- Clicar em **Executar auditoria**
- Aguardar a varredura (alguns segundos, dependendo do tamanho da base)

O relatório mostra 4 categorias:
- **UFs inválidas**: UFs que não estão entre as 27 do Brasil + marcadores `NA`/`LINDA` de bloqueio
- **Cidades não reconhecidas**: nomes que não batem no CSV, com sugestões fuzzy ("S.Paulo" → "São Paulo / SP")
- **Cidades em UF errada**: o nome existe no CSV mas só em UFs que não constam no caso (ex: cidade "Niterói" cadastrada num caso cujas UFs são `[SP]`)
- **Duplicatas no mesmo caso**: a mesma cidade aparecendo com duas grafias diferentes no mesmo CASO

Use o botão **Exportar (.txt)** pra salvar o relatório, abrir a planilha do Sheets e corrigir manualmente. Depois rode a auditoria de novo até zerar (ou aceitar as exceções).

**2. Gerenciar tags**

1. Em **Admin Mode → Gerenciar tags**
2. Ver a lista carregada (vai mostrar as tags atuais do projeto)
3. Adicionar/remover conforme necessário para a produção real

### Configuração nova em `config.php`

```php
define('DISTANCE_RADIUS_KM', 80);
```

Ajuste o valor se 80km não fizer sentido para algum cenário específico. Mexer aqui e re-subir o `config.php` no servidor para tomar efeito.

### Comportamento novo

- **Botão `🔄 Atualizar`** na topbar (ao lado de Histórico) — força refresh ignorando o cache MySQL. Use depois de adicionar casos novos no Sheets ou se uma sincronização normal não pegou.
- **Formulário "Registrar uso"** agora aceita múltiplas linhas. Botão "+ Adicionar mais um" empilha a linha atual; botão principal grava tudo de uma vez (atomicamente — se uma linha falha, nenhuma é gravada).
- **Tags** só podem ser aplicadas se estiverem cadastradas em `Gerenciar tags`. Usuário comum que tentar digitar tag não-cadastrada recebe a mensagem "peça ao admin".
- **Distância**: ao registrar uso, se houver cidade em uso no mesmo caso a menos de 80km:
  - Usuário comum: erro vermelho "Apenas administradores podem prosseguir — contate um admin."
  - Admin: warning amarelo com a lista das cidades e distâncias, com botão "Sim, continuar".
- **Registro em massa**: pré-flight no backend valida TODOS os casos antes de qualquer write. Se um caso tem cidade duplicada ou conflito de distância, nenhum dos casos é gravado.

---

## Resumo executivo

| Etapa | Tempo estimado |
|---|---|
| Backup dos 4 arquivos antigos | 1 min |
| Upload de `private-config/` (3 arquivos) | 1 min |
| Criar `assets/` + upload de 10 arquivos | 3 min |
| Criar `export/lib/` + upload do jszip | 1 min |
| Atualizar os 4 PHPs/HTMLs públicos | 2 min |
| Testes em aba anônima | 5 min |
| **Total** | **≈ 13 min** |
