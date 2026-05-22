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
