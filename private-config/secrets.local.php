<?php
/**
 * Segredos locais — MODELO (placeholders). NUNCA versione valores reais.
 *
 * Concentra as credenciais sensíveis que não devem entrar no repositório.
 * É carregado por config.php antes da definição dos fallbacks; qualquer
 * constante definida aqui prevalece sobre o placeholder vazio do config.
 *
 * Ao montar um servidor, copie este arquivo e preencha os valores reais.
 * Mantenha o arquivo fora do controle de versão.
 */

define('DB_PASS', 'SUA_SENHA_MYSQL_AQUI');
define('CRON_KEY', 'GERE_UMA_CHAVE_LONGA_E_ALEATORIA_AQUI_USE_OPENSSL_RAND_HEX_32');

// Cloudflare Turnstile — preencha após gerar as chaves no painel Cloudflare
// (ver seção "Turnstile" no DEPLOY.md). A site key é pública; a secret, não.
// Enquanto vazias, o Turnstile permanece desligado.
define('TURNSTILE_SITE_KEY', '');
define('TURNSTILE_SECRET', '');

// ── Meta Marketing API — V3 do /relatorio (ver relatorio/DEPLOY-V3.md) ──────
// Token do Usuário do Sistema do Gerenciador de Negócios, com permissão
// ads_read. É SOMENTE LEITURA — não gasta verba nem altera campanha. Nunca
// coloque o valor real em repositório: preencha apenas no servidor.
define('META_ACCESS_TOKEN', '');   // cole aqui o token real (somente no servidor)
define('META_API_VERSION', 'v21.0');
// Contas que a V3 mostra no seletor. DEIXE VAZIO para listar AUTOMATICAMENTE
// todas as contas que o token enxerga (recomendado — adicionar cliente passa a
// ser só fazer a parceria na Meta, sem mexer aqui). Preencha apenas se quiser
// CURAR/renomear a lista (vira allowlist fixa):
define('META_ACCOUNTS', [
    // ['label' => 'Cliente Exemplo', 'act_id' => '000000000000000'],
]);
