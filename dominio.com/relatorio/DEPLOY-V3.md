# V3 — Puxar o relatório direto da Meta · Guia de deploy e configuração

Guia bem passo a passo. Se algum termo parecer estranho, siga assim mesmo — cada
bloco diz **o que fazer** e **por quê**.

---

## 1. O que é a V3 (resumo)

Na V1 e na V2 você exporta 2 planilhas Excel da Meta e sobe à mão. A **V3 acaba com
isso**: você entra logado, escolhe o **cliente** e o **mês**, e o sistema busca os
números sozinho na conta de anúncios. O relatório sai no mesmo layout da V2.

**Você só precisa configurar UMA coisa no servidor: o(s) token(s) da Meta.** A lista de
clientes aparece **automaticamente** (todas as contas que o token enxerga).

> **Tem mais de uma BM?** (ex.: clientes divididos 50/50 entre BM1 e BM2, para evitar
> restrições.) Sem problema: você gera **um token por BM** e cola os dois. A V3 junta as
> contas das duas BMs no mesmo seletor e usa o token certo para cada cliente. **Não junte
> as BMs** — mantê-las separadas é o que protege você do contágio de restrições.

**Pré-requisitos:**
- Ser **admin do Gerenciador de Negócios** (Business Manager) da agência.
- Acesso às contas dos clientes (por posse ou **parceria**).
- Acesso ao servidor por **SFTP** (o mesmo do Pandora) para colar o token e subir 5 arquivos.

> A V3 só funciona **logado no Pandora**. V1 e V2 continuam abertas como antes.

---

## 2. O mapa do projeto no servidor (importante — tem DUAS pastas `api/`)

A maior confusão é que existem **duas** pastas chamadas `api/`. Elas são **diferentes**
e **não se misturam**:

```
SEU-DOMINIO/                         ← pasta pública do site (webroot)
├── index.php                        ← Pandora (banco de imagens)
├── api/                             ← (1) API GERAL do Pandora — NÃO é a V3
│   ├── handler.php                       (banco de imagens)
│   ├── cron.php
│   └── gerar-hash.php
├── assets/  export/  tools/
└── relatorio/                       ← o relatório de Meta Ads
    ├── index.html                   ← seletor de versão (V1 / V2 / V3)
    ├── Relatorio Dinamico.html      ← V1
    ├── RelatorioV2.html             ← V2
    ├── RelatorioV3.html             ← V3   ◀ NOVO
    ├── api/                         ← (2) API DA V3 — é ESTA   ◀ NOVA
    │   ├── v3-meta-insights.php          (fala com a Meta)
    │   └── .htaccess
    ├── js/
    │   ├── report-parser.js  report-render-v2.js  …
    │   └── meta-api-v3.js           ◀ NOVO
    ├── css/  vendor/  assets/  exel/

private-config/                      ← FORA do webroot (não acessível pela web)
├── config.php                       ← ALTERADO (lê as constantes META_*)
└── secrets.local.php                ← AQUI vai o token (nunca no Git)
```

- **`SEU-DOMINIO/api/`** = API geral do Pandora (banco de imagens). **Você não mexe nela.**
- **`SEU-DOMINIO/relatorio/api/`** = API da V3 (a que conversa com a Meta). **É a que você sobe.**
- **`private-config/`** fica **fora** da pasta pública — é onde mora o token, em segurança.

---

## 3. Parte A — Configurar a API da Meta (uma vez)

> ⚠️ **VOCÊ NÃO PRECISA "PUBLICAR" O APP.** Deixe ele em **"Não publicado" (modo de
> desenvolvimento)** mesmo. A tela **Publicar** (com Política de Privacidade e a lista de
> "requisitos") é a **Análise do App (App Review)** — ela só é exigida quando *outras
> pessoas* fazem login no seu app. No nosso caso, quem lê as contas é o **Usuário do
> Sistema da sua própria agência**, e isso funciona em desenvolvimento. **Ignore a tela
> "Publicar" e o botão azul de Publicar.**

### A1. Criar o App (você já fez: "Relatorios API")
1. Em <https://developers.facebook.com> → **Meus Apps → Criar app**.
2. Tipo: **"Negócios"**. Vincule ao seu **Gerenciador de Negócios**.
3. Em **Casos de uso**, adicione **"Mensurar dados de desempenho do anúncio com a API de
   Marketing"** (é o caso de uso que concede o `ads_read`). **Não precisa publicá-lo.**

### A2. Garantir que o App pertence ao Gerenciador de Negócios (passo que costuma faltar)
**Por quê:** se o app não estiver "dentro" da BM, ele **não aparece** na hora de gerar o
token — e nada funciona no Gerenciador.
1. <https://business.facebook.com/settings> → **Contas → Apps**.
2. Se **"Relatorios API"** não estiver na lista: **Adicionar → Conectar um ID de app** e
   cole o **ID do app** (fica em Configurações do app → Básico, no developers.facebook.com).
   Você precisa ser admin do app **e** da BM.

### A3. Criar o Usuário do Sistema (o "robô" que lê as contas)
**Por quê:** identidade de máquina que pertence à BM (não a uma pessoa) — é ela que carrega
o token; se alguém sair da equipe, o acesso não quebra.
1. Business Settings → **Usuários → Usuários do sistema → Adicionar**.
2. Nome: `Relatorios API`. Função: **Administrador**.

### A4. Atribuir as contas dos clientes ao Usuário do Sistema
**Por quê:** o robô só enxerga as contas que você atribuir — **é isto que faz os clientes
aparecerem na V3**, e é o motivo nº 1 de "não aparece nada".
1. No Usuário do Sistema → **Atribuir ativos → Contas de anúncios**.
2. Marque as contas e ligue **"Ver desempenho"** (leitura já basta).
- **Conta que é do cliente (parceria):** primeiro o cliente, no BM dele, vai em **Parceiros
  → Adicionar parceiro**, informa o **ID do seu negócio** e compartilha a conta; depois você
  a atribui ao Usuário do Sistema (passo acima). Ele continua dono e pode revogar; você só **lê**.

### A5. Gerar o token (a única coisa que vai pro servidor)
1. No Usuário do Sistema → **Gerar novo token**.
2. **App:** escolha "Relatorios API" (se ele **não aparecer** aqui, falta o passo A2).
3. **Permissões:** marque **`ads_read`** e **`business_management`** (esta ajuda a listar as
   contas sozinho).
4. **Expiração:** "Nunca", se houver a opção.
5. **Copie o token agora** — a Meta só mostra uma vez.

> **Teste rápido (opcional):** em **Ferramentas → Graph API Explorer**, escolha o app, cole
> o token e rode `me/adaccounts`. Se listar as contas, está tudo certo.

> **Se a lista de contas vier VAZIA** mesmo com tudo atribuído: em **Casos de uso → API de
> Marketing**, peça **"Acesso Avançado" (Advanced Access)** para `ads_read`. É uma
> solicitação **bem mais leve que publicar** — não exige a App Review completa.

> **Várias BMs:** repita A1–A5 em **cada** BM e guarde **um token de cada**. Um app pertence
> a uma BM, então provavelmente você terá um app por BM. **Não junte as BMs.**

---

## 4. Parte B — Colar o token no servidor

**Por que fica fora do site:** o token mora em `private-config/secrets.local.php`, que
fica **fora da pasta pública** e **nunca vai para o Git**. Assim ninguém baixa pelo
navegador nem encontra no repositório.

1. Conecte por **SFTP** (mesmo acesso do Pandora).
2. Abra `private-config/secrets.local.php` (na raiz da conta, **ao lado** da pasta do
   domínio — não dentro dela).
3. **Adicione** o bloco abaixo no final do arquivo (se ele já existir, só preencha) —
   **uma BM por linha**. **Não apague** as linhas de `DB_PASS`/`CRON_KEY` que já estão lá:
   ```php
   define('META_TOKENS', [
       ['label' => 'BM1', 'token' => 'TOKEN_DA_BM1'],
       ['label' => 'BM2', 'token' => 'TOKEN_DA_BM2'],   // remova esta linha se só tiver 1 BM
   ]);
   define('META_API_VERSION', 'v21.0');   // suba a versão quando a Meta atualizar
   define('META_ACCOUNTS', []);           // DEIXE VAZIO → lista os clientes sozinho
   ```
   > **`META_TOKENS` × `META_ACCESS_TOKEN` — qual a diferença?** Os dois guardam o MESMO
   > tipo de coisa: o token do passo A5. A diferença é só a forma:
   > - **`META_TOKENS`** = a **lista** para VÁRIAS BMs. Cada linha tem `label` (um apelido
   >   que VOCÊ inventa, só pra reconhecer — aparece no seletor) e `token` (a chave real
   >   gerada **naquela** BM). É o que você usa por ter 2 BMs.
   > - **`META_ACCESS_TOKEN`** = atalho de **uma BM só** (um campo único).
   >
   > **Use um OU outro.** Com 2 BMs: preencha `META_TOKENS` (2 linhas) e deixe
   > `META_ACCESS_TOKEN` vazio. `'TOKEN_DA_BM1'` é só um lugar reservado — troque pela chave
   > de verdade que você copiou logado **na BM1**; idem para a BM2.
4. Salve. Permissão do arquivo: **600** (`chmod 600 secrets.local.php`).

> **Sobre os clientes:** com `META_ACCOUNTS` vazio, a V3 mostra **automaticamente** todas as
> contas que o token enxerga. **Adicionar um cliente novo = só fazer a parceria (A3)** — não
> precisa voltar nesse arquivo. (Só preencha `META_ACCOUNTS` se quiser limitar/renomear a lista.)

---

## 5. Parte C — O que subir (arquivo por arquivo)

A pasta `relatorio/` (V1, V2, js, css…) **você já tem no servidor**. Para a V3, suba só
estes — repare nas DUAS áreas (webroot e private-config):

### 🟦 Área pública (dentro de `SEU-DOMINIO/`)
| Arquivo (no projeto)                         | Onde vai no servidor                              | O que é |
|----------------------------------------------|---------------------------------------------------|---------|
| `relatorio/RelatorioV3.html`                 | `SEU-DOMINIO/relatorio/RelatorioV3.html`          | NOVO — a página da V3 |
| `relatorio/js/meta-api-v3.js`                | `SEU-DOMINIO/relatorio/js/meta-api-v3.js`         | NOVO — o JS da V3 |
| `relatorio/api/v3-meta-insights.php`         | `SEU-DOMINIO/relatorio/api/v3-meta-insights.php`  | NOVO — o back-end (criar a pasta `relatorio/api/`) |
| `relatorio/api/.htaccess`                    | `SEU-DOMINIO/relatorio/api/.htaccess`             | NOVO — protege a pasta da API |
| `relatorio/index.html`                       | `SEU-DOMINIO/relatorio/index.html`                | ALTERADO — ativa o card V3 |

### 🟥 Área privada (em `private-config/`, FORA do webroot)
No servidor você **já tem** esses arquivos (o Pandora usa, com os dados reais). **NÃO
substitua** — **edite** e adicione só o que falta:

| Arquivo | O que fazer no servidor |
|---|---|
| `private-config/secrets.local.php` | **EDITAR** (não substituir): adicione o bloco `META_*` com o token (Parte B). **Não toque** nas linhas de `DB_PASS`/`CRON_KEY` existentes. |
| `private-config/config.php` | *(opcional)* adicionar os 4 fallbacks `META_*`. Dá pra **pular no teste**: como o token e a versão já vão no `secrets.local.php`, funciona sem mexer aqui. |

> ⚠️ A pasta `relatorio/api/` é **nova** — pode ser preciso criá-la no servidor antes de subir.
> Não confunda com `SEU-DOMINIO/api/` (a do Pandora geral) — ver o mapa na seção 2.
>
> `DEPLOY-V3.md` (este arquivo) **não precisa** ir para o servidor; é só o tutorial.

---

## 6. Parte D — Testar

1. Abra o site e **faça login no Pandora**.
2. Vá em `…/relatorio/` → clique no card **V3 — Puxar da Meta (API)**.
3. Aparece a tela "Puxar direto da Meta". A lista de clientes carrega sozinha.
4. Escolha o cliente, um mês com veiculação, e clique **Gerar relatório**.
5. Em alguns segundos o relatório aparece no layout da V2. Confira e exporte o PDF.

---

## 7. Parte E — Adicionar um cliente novo (depois)

**Só faça a parceria (Parte A3).** O cliente compartilha a conta com seu BM, você atribui
ao Usuário do Sistema, e na próxima vez ele **já aparece** no seletor da V3. **Sem mexer em
arquivo nenhum.**

---

## 8. Solução de problemas

| Mensagem na tela | O que significa / como resolver |
|---|---|
| **"Você precisa estar logado no Pandora"** | Faça login no Pandora e volte (a V3 usa o mesmo login). |
| **"A API da Meta ainda não foi configurada"** | O `META_ACCESS_TOKEN` está vazio no servidor → Parte B. |
| **"Nenhuma conta acessível pelo token"** | O token não tem contas atribuídas. Faça a parceria/atribuição (A3). Se persistir, gere o token com `business_management` (A4) ou preencha `META_ACCOUNTS` à mão. |
| **"O token da Meta está inválido ou expirou"** | Gere um token novo (A4) e cole de novo. |
| **"Sem permissão para ler esta conta"** | A conta não está atribuída ao Usuário do Sistema, ou a parceria foi revogada (A3). |
| **"A Meta está limitando as consultas"** | Excesso momentâneo. Espere alguns minutos. |
| **"Não há dados para essa conta neste mês"** | As campanhas não veicularam no período. |

### Ajustar o que conta como "Resultado"
Cada objetivo de campanha tem um "resultado" diferente (conversas, cliques, cadastros…). O
back-end já mapeia os casos comuns. Se vier zerado para algum cliente:
1. Acesse (logado) `…/relatorio/api/v3-meta-insights.php?account=ID&month=AAAA-MM&debug=1`
   → ele lista os **tipos de ação** daquela conta.
2. No arquivo `relatorio/api/v3-meta-insights.php`, ajuste o mapa **`$RESULT_BY_OBJECTIVE`**
   (tem um comentário "AJUSTE AQUI") e suba o `.php` de novo.

---

## 9. Segurança (resumo)

- O **token** fica só em `secrets.local.php` (fora do webroot, fora do Git). O navegador
  nunca o vê — ele só fala com o nosso back-end.
- O token é **`ads_read`** (só leitura): não gasta verba nem altera campanha.
- A V3 exige **login do Pandora** + token **CSRF** em cada geração.
- **Nada é salvo:** os números não vão para banco nem disco; somem ao fechar a aba.
- A pasta `relatorio/uploads/` (PDFs/imagens de clientes) **não** vai para o Git (está no
  `.gitignore`). No servidor ela continua existindo normalmente.
