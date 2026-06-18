<?php
/**
 * Sessão do relatório — diz quem está logado no sistema e permite sair.
 *
 * Compartilha o MESMO cookie/sessão (bi_session) do sistema, igual ao
 * v3-meta-insights.php. Usado pelo chip de login (login-chip.js) que aparece
 * nas páginas do relatório.
 *
 *   GET            → { logged, user, csrf }
 *   POST {logout}  → encerra a sessão (exige X-CSRF-Token) → { ok, logged:false }
 */
header('Content-Type: application/json; charset=utf-8');

$cfgPath = null; $dir = __DIR__;
for ($i = 0; $i < 6; $i++) { $c = $dir . '/private-config/config.php'; if (is_file($c)) { $cfgPath = $c; break; } $dir = dirname($dir); }
if (!$cfgPath) { echo json_encode(['logged' => false]); exit; }
require_once $cfgPath;

$sessionDir = PRIVATE_CONFIG_PATH . '/sessions';
if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
ini_set('session.save_path', $sessionDir);
ini_set('session.gc_maxlifetime', SESSION_LIFETIME);
ini_set('session.use_strict_mode', '1');
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME, 'path' => '/',
    'secure' => isset($_SERVER['HTTPS']), 'httponly' => true, 'samesite' => 'Lax',
]);
session_name('bi_session');
session_start();
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));

$expired = isset($_SESSION['login_time']) && (time() - $_SESSION['login_time']) > SESSION_LIFETIME;
$logged  = !empty($_SESSION['user']) && !$expired;

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true) ?: [];
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($sent) || !hash_equals($_SESSION['csrf'] ?? '', $sent)) {
        http_response_code(403); echo json_encode(['ok' => false, 'error' => 'CSRF']); exit;
    }
    if (!empty($body['logout'])) {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $p = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $p['path'], $p['domain'] ?? '', !empty($p['secure']), !empty($p['httponly']));
        }
        session_destroy();
        echo json_encode(['ok' => true, 'logged' => false]); exit;
    }
}

echo json_encode([
    'logged' => $logged,
    'user'   => $logged ? $_SESSION['user'] : null,
    'csrf'   => $_SESSION['csrf'],
], JSON_UNESCAPED_UNICODE);
