<?php
/**
 * Gerador de hash de senha — ferramenta administrativa.
 *
 * Página protegida por login de administrador. Recebe uma senha em texto,
 * devolve o hash bcrypt correspondente (PASSWORD_DEFAULT) para colar em
 * config.php (constante USERS) ao criar/redefinir um usuário diretamente no
 * arquivo. Não persiste nada: apenas gera e exibe o hash para o admin logado.
 *
 * Para o dia a dia (trocar a própria senha), use o painel admin do app, que
 * grava em passwords.json sem editar config.php.
 */
require_once __DIR__ . '/../../private-config/config.php';

// Sessão idêntica à do handler.php para reaproveitar o login existente.
$sessionDir = PRIVATE_CONFIG_PATH . '/sessions';
if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
ini_set('session.save_path',       $sessionDir);
ini_set('session.gc_maxlifetime',  SESSION_LIFETIME);
ini_set('session.use_strict_mode', '1');
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME,
    'path'     => '/',
    'secure'   => isset($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_name('bi_session');
session_start();

/** Resolve se o usuário tem papel admin (users_override.json tem precedência). */
function _ghIsAdmin(string $user): bool {
    $ovrPath = PRIVATE_CONFIG_PATH . '/users_override.json';
    if (is_file($ovrPath)) {
        $ovr = json_decode((string) file_get_contents($ovrPath), true) ?: [];
        if (isset($ovr[$user])) return ($ovr[$user]['role'] ?? 'user') === 'admin';
    }
    if (isset(USERS[$user])) {
        $u = USERS[$user];
        return is_array($u) && (($u['role'] ?? 'user') === 'admin');
    }
    return false;
}

$me = $_SESSION['user'] ?? '';
$sessionOk = $me !== ''
    && (!isset($_SESSION['login_time']) || (time() - $_SESSION['login_time']) <= SESSION_LIFETIME);

if (!$sessionOk || !_ghIsAdmin($me)) {
    http_response_code(403);
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><meta charset="utf-8"><title>Acesso negado</title>'
        . '<body style="font-family:system-ui;background:#0f1115;color:#e6e6e6;padding:3rem;text-align:center">'
        . '<h2>Acesso restrito</h2><p>Faça login como administrador no app antes de abrir esta ferramenta.</p>'
        . '<p><a style="color:#6ea8fe" href="../">Voltar ao Banco de Imagens</a></p></body>';
    exit;
}

$hash = null;
$errStr = null;
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $pwd = (string) ($_POST['pwd'] ?? '');
    if (strlen($pwd) < 6) {
        $errStr = 'A senha precisa ter ao menos 6 caracteres.';
    } else {
        $hash = password_hash($pwd, PASSWORD_DEFAULT);
    }
}

header('Content-Type: text/html; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
?>
<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Gerador de hash · Banco de Imagens</title>
<style>
  :root{color-scheme:dark}
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0f1115;color:#e6e6e6;margin:0;padding:2.5rem 1rem;display:flex;justify-content:center}
  .card{background:#171a21;border:1px solid #2a2f3a;border-radius:14px;padding:2rem;width:100%;max-width:560px;box-shadow:0 10px 40px rgba(0,0,0,.4)}
  h1{font-size:20px;margin:0 0 .25rem}
  p.sub{color:#9aa3b2;font-size:13px;margin:0 0 1.5rem}
  label{display:block;font-size:13px;font-weight:600;margin-bottom:.4rem}
  input[type=text]{width:100%;box-sizing:border-box;background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;padding:11px 12px;color:#e6e6e6;font-size:15px}
  button{margin-top:1rem;width:100%;background:#3b82f6;color:#fff;border:0;border-radius:8px;padding:12px;font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#2f6fe0}
  .out{margin-top:1.5rem}
  .hashbox{background:#0f1115;border:1px solid #2a2f3a;border-radius:8px;padding:12px;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px;word-break:break-all;color:#7ee787}
  .err{margin-top:1rem;color:#ff7b72;font-size:13px}
  .copy{margin-top:.6rem;background:#2a2f3a}
  .note{margin-top:1.5rem;font-size:12px;color:#9aa3b2;line-height:1.6;border-top:1px solid #2a2f3a;padding-top:1rem}
  code{background:#0f1115;padding:1px 5px;border-radius:4px;border:1px solid #2a2f3a}
  a{color:#6ea8fe}
</style>
</head>
<body>
<div class="card">
  <h1>Gerador de hash de senha</h1>
  <p class="sub">Logado como <b><?php echo htmlspecialchars($me, ENT_QUOTES); ?></b> · gera o hash bcrypt para colar no <code>config.php</code>.</p>

  <form method="post" autocomplete="off">
    <label for="pwd">Senha</label>
    <input type="text" id="pwd" name="pwd" placeholder="digite a senha desejada" autofocus>
    <button type="submit">Gerar hash</button>
  </form>

  <?php if ($errStr !== null): ?>
    <div class="err"><?php echo htmlspecialchars($errStr, ENT_QUOTES); ?></div>
  <?php endif; ?>

  <?php if ($hash !== null): ?>
    <div class="out">
      <label>Hash gerado</label>
      <div class="hashbox" id="hashbox"><?php echo htmlspecialchars($hash, ENT_QUOTES); ?></div>
      <button type="button" class="copy" onclick="navigator.clipboard.writeText(document.getElementById('hashbox').textContent).then(()=>{this.textContent='Copiado!';setTimeout(()=>this.textContent='Copiar hash',1500)})">Copiar hash</button>
    </div>
  <?php endif; ?>

  <div class="note">
    Cole o hash no <code>config.php</code>, na constante <code>USERS</code>, por exemplo:<br>
    <code>'novousuario' =&gt; ['hash' =&gt; 'COLE_AQUI', 'role' =&gt; 'user'],</code><br><br>
    Para trocar a sua própria senha no dia a dia, prefira o painel admin do app
    (não precisa editar arquivo). <a href="../">Voltar ao app</a>.
  </div>
</div>
</body>
</html>
