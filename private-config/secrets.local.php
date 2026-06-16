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
// Tokens de Usuário do Sistema (permissão ads_read — SÓ LEITURA: não gasta nem
// altera campanha). UMA BM = UM TOKEN. Se você divide os clientes entre BMs
// (ex.: 50/50), liste TODAS aqui: a V3 junta as contas das duas no mesmo seletor
// e usa o token certo por conta. NUNCA versione os valores reais — só no servidor.
define('META_TOKENS', [
    // ['label' => 'BM1', 'token' => 'TOKEN_REAL_DA_BM1'],
    // ['label' => 'BM2', 'token' => 'TOKEN_REAL_DA_BM2'],
]);
define('META_API_VERSION', 'v21.0');

// Tem UMA BM só? Pode usar este campo único e deixar META_TOKENS vazio:
define('META_ACCESS_TOKEN', '');

// Contas que a V3 mostra. DEIXE VAZIO para listar AUTOMATICAMENTE todas as contas
// que os tokens enxergam (recomendado — adicionar cliente é só fazer a parceria
// na Meta). Preencha só para curar/renomear; aí use 'bm' = índice do token (0 = 1º):
define('META_ACCOUNTS', [
    // ['label' => 'Cliente X', 'act_id' => '000000000000000', 'bm' => 0],
]);
