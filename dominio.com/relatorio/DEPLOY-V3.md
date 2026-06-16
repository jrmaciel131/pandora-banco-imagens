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

### A1. Criar um App da Meta
**Por quê:** a Meta só conversa com a API através de um "App" registrado.
1. Entre em <https://developers.facebook.com> com o Facebook que administra o negócio.
2. **Meus Apps → Criar app → tipo "Negócios" (Business)**. Associe ao seu Gerenciador de Negócios.
3. Adicione o produto **"Marketing API"**.

### A2. Criar um Usuário do Sistema (o "robô" que lê as contas)
**Por quê:** é uma identidade de máquina que pertence ao negócio (não a uma pessoa) — é
ela que carrega o token. Se alguém sair da equipe, o acesso não quebra.
1. <https://business.facebook.com/settings> → **Usuários → Usuários do sistema → Adicionar**.
2. Nome: `Relatorios API`. Função: **Administrador**.

### A3. Dar acesso às contas dos clientes (a parceria)
**Por quê:** o robô só lê as contas que você liberar para ele. **É isso que faz cada
cliente aparecer sozinho na V3.**
- **Conta sua (no seu BM):** Configurações do negócio → **Contas → Contas de anúncios** →
  selecione a conta → **Atribuir** o Usuário do Sistema `Relatorios API` com **"Ver desempenho"**.
- **Conta do cliente (parceria):** o cliente, no BM dele, vai em **Parceiros → Adicionar
  parceiro**, informa o **ID do seu negócio** e compartilha a **conta de anúncios**. Depois,
  do seu lado, atribua essa conta ao Usuário do Sistema. O cliente continua dono e pode
  revogar quando quiser; você só **lê** (não gasta, não altera campanha).

### A4. Gerar o token (a única coisa que você cola no servidor)
1. Em **Usuários do sistema**, selecione `Relatorios API` → **Gerar novo token**.
2. Escolha o **App** do passo A1.
3. Permissões: marque **`ads_read`** (recomendo marcar também **`business_management`** —
   ajuda a listar as contas automaticamente).
4. Expiração: **"Nunca"**, se a opção existir.
5. **Copie o token agora** — a Meta só mostra uma vez.

> **Várias BMs:** se você divide os clientes entre 2 (ou mais) BMs, **repita os passos
> A1–A4 em cada BM** e guarde **um token de cada**. (Pode ser preciso ter um App por BM no
> passo A1, já que um App pertence a uma BM.)

---

## 4. Parte B — Colar o token no servidor

**Por que fica fora do site:** o token mora em `private-config/secrets.local.php`, que
fica **fora da pasta pública** e **nunca vai para o Git**. Assim ninguém baixa pelo
navegador nem encontra no repositório.

1. Conecte por **SFTP** (mesmo acesso do Pandora).
2. Abra `private-config/secrets.local.php` (na raiz da conta, **ao lado** da pasta do
   domínio — não dentro dela).
3. Preencha **os tokens** (o bloco já existe no arquivo) — **uma BM por linha**:
   ```php
   define('META_TOKENS', [
       ['label' => 'BM1', 'token' => 'TOKEN_DA_BM1'],
       ['label' => 'BM2', 'token' => 'TOKEN_DA_BM2'],   // remova esta linha se só tiver 1 BM
   ]);
   define('META_API_VERSION', 'v21.0');   // suba a versão quando a Meta atualizar
   define('META_ACCOUNTS', []);           // DEIXE VAZIO → lista os clientes sozinho
   ```
   > **Só tem 1 BM?** Pode usar `define('META_ACCESS_TOKEN', 'SEU_TOKEN');` e deixar
   > `META_TOKENS` vazio — tanto faz.
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
| Arquivo                          | Onde vai no servidor               | O que é |
|----------------------------------|------------------------------------|---------|
| `private-config/config.php`      | `private-config/config.php`        | ALTERADO — passa a ler as constantes META_* |
| `private-config/secrets.local.php` | `private-config/secrets.local.php` | É onde você colou o token (Parte B) |

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
