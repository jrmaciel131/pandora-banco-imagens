<?php
/**
 * Banco de Imagens — Configuração privada da aplicação.
 *
 * Este arquivo reside fora do document root público e, portanto, não é
 * acessível via HTTP. Concentra as constantes globais usadas pelos demais
 * módulos: caminhos, credenciais, política de sessão e definições de bases.
 *
 * IMPORTANTE: substitua todos os placeholders abaixo (SEU_*, valores de
 * exemplo) pelos valores reais do seu ambiente antes de subir ao servidor.
 */

/**
 * Caminho absoluto da pasta pública. Normalmente é definido pelos entry
 * scripts (handler.php, cron.php) antes do require deste arquivo; o
 * fallback assume a estrutura padrão `private-config/` irmã do domínio.
 */
if (!defined('WEB_ROOT')) {
    define('WEB_ROOT', dirname(__DIR__) . '/SEU_DOMINIO_OU_PUBLIC_HTML');
}

/**
 * Caminho desta pasta privada. Utilizado para localizar arquivos auxiliares
 * (passwords.json, users_override.json, production_users.json, etc.).
 */
define('PRIVATE_CONFIG_PATH', __DIR__);

/**
 * Segredos sensíveis (senha do banco, CRON_KEY, chaves do Turnstile) residem em
 * secrets.local.php, que NÃO é versionado. Carregado aqui antes dos fallbacks
 * abaixo; se ausente, as constantes assumem valores vazios. Use o modelo de
 * secrets.local.php incluído neste repositório como ponto de partida.
 */
$_secretsFile = __DIR__ . '/secrets.local.php';
if (is_file($_secretsFile)) require_once $_secretsFile;
unset($_secretsFile);

define('APP_VERSION', 'v23.00');

/**
 * Usuários estáticos do sistema. As senhas são hashes bcrypt — gere com:
 *   php -r 'echo password_hash("SUA_SENHA", PASSWORD_DEFAULT) . "\n";'
 *
 * Papéis disponíveis: 'admin' (acesso total) e 'user' (limitado).
 */
define('USERS', [
    'admin' => ['hash' => '$2y$12$REPLACE_ME_WITH_REAL_BCRYPT_HASH_FOR_ADMIN_USER____________', 'role' => 'admin'],
    'user1' => ['hash' => '$2y$12$REPLACE_ME_WITH_REAL_BCRYPT_HASH_FOR_USER1____________________', 'role' => 'user'],
]);

/**
 * Bases de dados disponíveis na aplicação.
 *
 * Cada base aponta para uma planilha do Google Sheets, uma pasta do Drive
 * e um conjunto de tabelas MySQL identificadas pelo prefixo `db_prefix`.
 * A flag `is_test` marca ambientes de sandbox aos quais usuários comuns
 * têm acesso por padrão.
 */
define('BASES', [
    'TESTE' => [
        'label'           => 'Base Teste',
        'emoji'           => '🧪',
        'spreadsheet_id'  => 'SEU_SPREADSHEET_ID_DA_BASE_TESTE_AQUI',
        'sheet_name'      => 'CASOS ONLINE',
        'drive_folder_id' => 'SEU_DRIVE_FOLDER_ID_DA_BASE_TESTE_AQUI',
        'thumb_dir'       => WEB_ROOT . '/thumbs-teste',
        'thumb_base_url'  => '/thumbs-teste',
        'db_prefix'       => 'teste_',
        'is_test'         => true,
    ],
    'PRODUCAO' => [
        'label'           => 'Base Produção',
        'emoji'           => '🟦',
        'spreadsheet_id'  => 'SEU_SPREADSHEET_ID_DA_PRODUCAO_AQUI',
        'sheet_name'      => 'CASOS ONLINE',
        'drive_folder_id' => 'SEU_DRIVE_FOLDER_ID_DA_PRODUCAO_AQUI',
        'thumb_dir'       => WEB_ROOT . '/thumbs',
        'thumb_base_url'  => '/thumbs',
        'db_prefix'       => '',
    ],
]);

/**
 * Conjunto de bases tratadas como ambiente de produção. O acesso é
 * restrito a administradores e a usuários autorizados em
 * `production_users.json`. Demais usuários enxergam apenas bases que
 * não constam desta lista (por convenção, a base TESTE).
 */
define('PRODUCTION_BASES', ['PRODUCAO']);

/** Caminho absoluto do JSON de credenciais da conta de serviço Google. */
define('GOOGLE_CREDENTIALS_PATH', __DIR__ . '/google-credentials.json');

define('DB_HOST', 'SEU_HOST_MYSQL_AQUI');
define('DB_NAME', 'SEU_NOME_DE_BANCO_AQUI');
define('DB_USER', 'SEU_USUARIO_MYSQL_AQUI');
// DB_PASS é definida em secrets.local.php (fora do Git); fallback vazio.
if (!defined('DB_PASS')) define('DB_PASS', '');
define('CACHE_TTL',        300);
define('THUMB_CACHE_TTL',  2592000);
define('FOLDER_CACHE_TTL', 3600);
// Duração da sessão. Reduzida de 4h para 2h porque o renew automático
// (botão "Renovar sessão" e ação do usuário) já mantém logado quem está
// ativo. 2h limita a janela de risco se alguém esquecer a máquina aberta.
define('SESSION_LIFETIME',    7200);
define('SESSION_WARN_BEFORE', 900);
define('MAX_LOGIN_ATTEMPTS',  5);
define('LOGIN_BLOCK_MINUTES', 15);
// CRON_KEY é definida em secrets.local.php (fora do Git); fallback vazio.
if (!defined('CRON_KEY')) define('CRON_KEY', '');

// Cloudflare Turnstile (CAPTCHA do login). Definidas em secrets.local.php.
// Enquanto vazias, o Turnstile fica desligado e o login funciona normalmente.
if (!defined('TURNSTILE_SITE_KEY')) define('TURNSTILE_SITE_KEY', '');
if (!defined('TURNSTILE_SECRET'))   define('TURNSTILE_SECRET', '');

// Meta Marketing API (Graph API) — usada pela V3 do /relatorio. O token do
// Usuário do Sistema (permissão ads_read) e a lista de contas dos clientes são
// sensíveis e ficam em secrets.local.php (fora do Git). Aqui só os fallbacks:
// enquanto o token estiver vazio, a V3 responde "API não configurada".
// Passo a passo em dominio.com/relatorio/DEPLOY-V3.md.
if (!defined('META_ACCESS_TOKEN')) define('META_ACCESS_TOKEN', '');
if (!defined('META_API_VERSION'))  define('META_API_VERSION', 'v21.0');
if (!defined('META_ACCOUNTS'))     define('META_ACCOUNTS', []);

// Raio mínimo (em km) entre uma cidade nova e qualquer cidade já em uso no
// mesmo caso. Usuários comuns são bloqueados se houver conflito; apenas admins
// podem confirmar para prosseguir.
//
// O valor padrão abaixo pode ser sobrescrito em tempo de execução pelo arquivo
// `distance_config.json` (gravado pelo painel admin), evitando editar este
// arquivo manualmente. O JSON tem o formato {"radius_km": 80}.
$_distRadius = 80;
$_distOverride = PRIVATE_CONFIG_PATH . '/distance_config.json';
if (is_file($_distOverride)) {
    $_distData = json_decode(@file_get_contents($_distOverride), true);
    if (is_array($_distData) && isset($_distData['radius_km'])
        && is_numeric($_distData['radius_km']) && $_distData['radius_km'] > 0) {
        $_distRadius = (float) $_distData['radius_km'];
    }
}
define('DISTANCE_RADIUS_KM', $_distRadius);
unset($_distRadius, $_distOverride, $_distData);
