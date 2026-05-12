<?php
/**
 * Banco de Imagens — Configuração privada da aplicação.
 *
 * Este arquivo reside fora do document root público e, portanto, não é
 * acessível via HTTP. Concentra as constantes globais usadas pelos demais
 * módulos: caminhos, credenciais, política de sessão e definições de bases.
 *
 * ⚠️ ATENÇÃO — versão sanitizada para o GitHub
 * --------------------------------------------------------
 * Os valores reais (senhas, hashes, IDs do Google e chaves) foram
 * substituídos por placeholders. Antes de subir este arquivo para o
 * servidor de produção, troque cada placeholder pelo valor correspondente.
 * NUNCA comite este arquivo já preenchido.
 */

if (!defined('WEB_ROOT')) {
    define('WEB_ROOT', dirname(__DIR__) . '/dominio.com');
}

define('PRIVATE_CONFIG_PATH', __DIR__);

define('APP_VERSION', 'v19.00');

/**
 * Lista de usuários e seus hashes bcrypt.
 *
 * Para gerar um hash novo no PHP:
 *   echo password_hash('senha-em-texto-limpo', PASSWORD_BCRYPT, ['cost'=>12]);
 */
define('USERS', [
    'adm1'   => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'admin'],
    'lider'  => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'admin'],
    'fabio'  => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'admin'],
    'adm3'   => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'user'],
    'adm6'   => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'user'],
    'adm7'   => ['hash' => 'BCRYPT_HASH_DO_USUARIO_AQUI',   'role' => 'user'],
]);

define('BASES', [
    'TESTE' => [
        'label'           => 'Base Teste',
        'emoji'           => '🧪',
        'spreadsheet_id'  => 'ID_DA_PLANILHA_GOOGLE_AQUI',
        'sheet_name'      => 'CASOS ONLINE',
        'drive_folder_id' => 'ID_DA_PASTA_DO_DRIVE_AQUI',
        'thumb_dir'       => WEB_ROOT . '/thumbs-teste',
        'thumb_base_url'  => '/thumbs-teste',
        'db_prefix'       => 'teste_',
        'is_test'         => true,
    ],
    'PH' => [
        'label'           => 'Base PH',
        'emoji'           => '🟦',
        'spreadsheet_id'  => 'ID_DA_PLANILHA_GOOGLE_AQUI',
        'sheet_name'      => 'CASOS ONLINE',
        'drive_folder_id' => 'ID_DA_PASTA_DO_DRIVE_AQUI',
        'thumb_dir'       => WEB_ROOT . '/thumbs',
        'thumb_base_url'  => '/thumbs',
        'db_prefix'       => '',
    ],
    'PO' => [
        'label'           => 'Base PO',
        'emoji'           => '🟩',
        'spreadsheet_id'  => 'ID_DA_PLANILHA_GOOGLE_AQUI',
        'sheet_name'      => 'CASOS-ONLINE',
        'drive_folder_id' => 'ID_DA_PASTA_DO_DRIVE_AQUI',
        'thumb_dir'       => WEB_ROOT . '/thumbs-po',
        'thumb_base_url'  => '/thumbs-po',
        'db_prefix'       => 'po_',
    ],
]);

define('PRODUCTION_BASES', ['PH','PO']);

define('GOOGLE_CREDENTIALS_PATH', __DIR__ . '/google-credentials.json');

define('DB_HOST', 'HOST_DO_MYSQL_AQUI');
define('DB_NAME', 'NOME_DO_BANCO_AQUI');
define('DB_USER', 'USUARIO_DO_BANCO_AQUI');
define('DB_PASS', 'SENHA_DO_BANCO_AQUI');

define('CACHE_TTL',        300);
define('THUMB_CACHE_TTL',  2592000);
define('FOLDER_CACHE_TTL', 3600);
define('SESSION_LIFETIME',    14400);
define('SESSION_WARN_BEFORE', 900);
define('MAX_LOGIN_ATTEMPTS',  5);
define('LOGIN_BLOCK_MINUTES', 15);

/**
 * Chave aleatória usada como "token" na URL do cron.
 * Gerar uma nova em PHP: bin2hex(random_bytes(32)) . '.php'
 */
define('CRON_KEY', 'TOKEN_LONGO_E_ALEATORIO_AQUI.php');
