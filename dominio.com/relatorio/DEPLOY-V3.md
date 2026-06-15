# V3 — Puxar o relatório direto da Meta (deploy + configuração da API)

Este guia é bem passo a passo de propósito. Se algum termo parecer estranho, siga
o passo mesmo assim — cada bloco explica **o que fazer** e **por que**.

## O que é a V3 (em 1 parágrafo)

Na V1 e na V2 você exporta 2 planilhas Excel da Meta e sobe à mão. A **V3 elimina
isso**: você escolhe o cliente e o mês, e o sistema busca os números sozinho na conta
de anúncios, usando um **token da sua agência**. O relatório aparece no mesmo layout da
V2. Nada é salvo — cada relatório é uma consulta nova (mais simples e mais seguro).

**Você vai precisar de:**
- Ser **admin do Gerenciador de Negócios** (Business Manager) da agência.
- Acesso às contas de anúncios dos clientes (por posse ou **parceria**).
- Acesso ao servidor por **SFTP** (o mesmo do Pandora) para colar o token.

> A V3 só funciona **logado no Pandora**. V1 e V2 continuam abertas como antes.

---

## Parte A — Configurar a API da Meta (uma vez na vida)

### A1. Criar um App da Meta (gera o "crachá" do sistema)

**Por quê:** a Meta só conversa com a API através de um "App" registrado.

1. Entre em <https://developers.facebook.com> com o Facebook que administra o negócio.
2. **Meus Apps → Criar app**. Em tipo, escolha **"Negócios" (Business)**.
3. Dê um nome (ex.: `Relatórios Tavares`) e associe ao seu **Gerenciador de Negócios**.
4. No painel do app, em **Adicionar produtos**, adicione **"Marketing API"**.
5. Anote o **ID do app** e o **Segredo do app** (em Configurações → Básico). *(Para a V3
   o token basta; o segredo fica guardado para o futuro.)*

### A2. Criar um Usuário do Sistema (o "robô" que lê as contas)

**Por quê:** um Usuário do Sistema é uma identidade de máquina que pertence ao seu
negócio (não a uma pessoa). É ele que carrega o token — assim, se alguém sair da
equipe, o acesso não quebra.

1. Vá em <https://business.facebook.com/settings> (**Configurações do negócio**).
2. Menu **Usuários → Usuários do sistema → Adicionar**.
3. Nome: `Relatorios API`. Função: **Administrador** (ou Funcionário).

### A3. Dar acesso às contas dos clientes ao Usuário do Sistema

**Por quê:** o robô só lê as contas que você atribuir a ele.

- **Conta que é sua (criada no seu BM):** Configurações do negócio → **Contas → Contas de
  anúncios** → selecione a conta → **Atribuir parceiros/pessoas** → escolha o Usuário do
  Sistema `Relatorios API` → permissão **"Ver desempenho"** (leitura) já basta.
- **Conta do cliente (parceria):** peça ao cliente para, no Gerenciador de Negócios DELE,
  ir em **Parceiros → Adicionar parceiro** e informar o **ID do seu negócio** (aparece em
  Configurações do negócio → Informações do negócio). Ele compartilha a **conta de
  anúncios** com a sua agência. Depois, do seu lado, atribua essa conta ao Usuário do
  Sistema (como acima). O cliente continua dono da conta e pode revogar quando quiser —
  você nunca pede a senha dele e só consegue **ler** (não gasta, não altera campanha).

### A4. Gerar o token (a "senha" de leitura)

**Por quê:** o token é o que autoriza a leitura. É o único segredo sensível da V3.

1. Em **Usuários do sistema**, selecione `Relatorios API` → **Gerar novo token**.
2. Escolha o **App** criado em A1.
3. Em permissões, marque **`ads_read`** (e, se quiser que a lista de contas venha
   automática no futuro, também `business_management`).
4. Em expiração, escolha **"Nunca"** (token de longa duração) se a opção existir.
5. **Copie o token agora** — a Meta só mostra uma vez. Guarde num lugar seguro.

### A5. Pegar o ID de cada conta de cliente (`act_id`)

**Por quê:** a V3 identifica cada cliente pelo número da conta de anúncios.

- No **Gerenciador de Anúncios**, no seletor de contas, aparece **"ID da conta: 123456789012345"**.
- Anote **só os números** (sem o `act_`). Você vai cadastrar um par `label + act_id` por cliente.

---

## Parte B — Pôr o token no servidor (com segurança)

**Por quê isso fica fora do site:** o token mora em `private-config/secrets.local.php`,
que fica **fora da pasta pública** e **nunca vai para o Git**. Assim ele não aparece em
nenhum repositório nem pode ser baixado pelo navegador.

1. Conecte no servidor por **SFTP** (mesmo acesso do Pandora).
2. Abra o arquivo `private-config/secrets.local.php` (na raiz da conta, ao lado da pasta
   do domínio — **não** dentro dela).
3. Preencha o bloco da Meta (que já existe no arquivo):

   ```php
   define('META_ACCESS_TOKEN', 'COLE_AQUI_O_TOKEN_DO_PASSO_A4');
   define('META_API_VERSION', 'v21.0');   // pode subir a versão quando a Meta atualizar
   define('META_ACCOUNTS', [
       ['label' => 'Clínica Yuri',   'act_id' => '123456789012345'],
       ['label' => 'Cliente 2',      'act_id' => '987654321098765'],
       // adicione um por cliente (label = nome que aparece no seletor)
   ]);
   ```

4. Salve. Confira a permissão do arquivo: deve ser **600** (`chmod 600 secrets.local.php`).

> Para adicionar um cliente novo depois, basta acrescentar uma linha em `META_ACCOUNTS` e
> garantir que a conta dele está atribuída ao Usuário do Sistema (Parte A3). **Sem mexer em
> código.**

---

## Parte C — Subir os arquivos da V3

Igual ao `DEPLOY.md` do Pandora, separe em duas áreas.

**Pasta pública (webroot — `seu-dominio.com/`):**
- `relatorio/RelatorioV3.html` *(novo)*
- `relatorio/js/meta-api-v3.js` *(novo)*
- `relatorio/index.html` *(atualizado: o card V3 deixou de ser "Em breve")*
- `relatorio/api/v3-meta-insights.php` *(novo — o backend)*
- `relatorio/api/.htaccess` *(novo)*

**Pasta privada (fora do webroot — `private-config/`):**
- `private-config/config.php` *(atualizado: lê as constantes META_* com fallback vazio)*
- `private-config/secrets.local.php` *(o token real — você preencheu na Parte B; nunca vem pelo Git)*

> A pasta `relatorio/uploads/` (PDFs/imagens de clientes) **não** sobe pelo Git e não deve ir
> para repositório — está no `.gitignore`. No servidor ela continua existindo normalmente.

---

## Parte D — Testar

1. Abra o site e **faça login no Pandora** (a V3 exige login).
2. Vá em `…/relatorio/` e clique no card **V3 — Puxar da Meta (API)**.
3. Deve aparecer a tela "Puxar direto da Meta" com a lista de clientes e o seletor de mês.
4. Escolha um cliente, um mês com veiculação e clique **Gerar relatório**.
5. Em alguns segundos o relatório aparece no layout da V2. Confira os números e exporte o PDF.

---

## Solução de problemas

| Mensagem na tela | O que significa / como resolver |
|---|---|
| **"Você precisa estar logado no Pandora"** | Abra o Pandora, faça login e volte. (A V3 reaproveita o login do Pandora.) |
| **"A API da Meta ainda não foi configurada"** | O `META_ACCESS_TOKEN` está vazio no servidor. Volte à Parte B. |
| **"Nenhuma conta cadastrada"** | Faltou preencher `META_ACCOUNTS` no `secrets.local.php`. |
| **"O token da Meta está inválido ou expirou"** | Gere um token novo (Parte A4) e cole de novo. Tokens que não são "Nunca" expiram. |
| **"Sem permissão para ler esta conta"** | A conta não está atribuída ao Usuário do Sistema, ou a parceria foi revogada (Parte A3). |
| **"A Meta está limitando as consultas"** | Excesso de chamadas momentâneo. Espere alguns minutos. |
| **"Não há dados para essa conta neste mês"** | As campanhas não veicularam no período escolhido. |

### Ajustar o que conta como "Resultado"

Cada objetivo de campanha tem um "resultado" diferente (conversas, cliques, cadastros,
compras…). O backend já mapeia os casos comuns, mas se algum cliente usar um objetivo
incomum e os resultados vierem zerados:

1. Acesse (logado) `…/relatorio/api/v3-meta-insights.php?account=ACT_ID&month=AAAA-MM&debug=1`.
   Ele lista os **tipos de ação** que aquela conta realmente retorna.
2. No arquivo `relatorio/api/v3-meta-insights.php`, ajuste o mapa **`$RESULT_BY_OBJECTIVE`**
   (tem um comentário "AJUSTE AQUI") incluindo o tipo de ação certo para o objetivo.
3. Suba o `.php` novamente.

---

## Segurança — resumo

- O **token** fica só em `secrets.local.php` (fora do webroot, fora do Git). O navegador
  nunca o vê — ele só fala com o nosso próprio backend.
- O token é **`ads_read`** (somente leitura): não gasta verba nem altera campanha.
- A V3 exige **login do Pandora** + token **CSRF** em cada geração.
- **Nada é salvo:** os números não vão para banco nem disco; somem quando a aba fecha.
- O backend só aceita contas listadas em **`META_ACCOUNTS`** (lista branca).
