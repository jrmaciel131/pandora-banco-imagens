<?php
/**
 * Banco de Imagens — Front controller da API JSON.
 *
 * Ponto único de entrada para todas as ações invocadas pelo frontend.
 * Realiza bootstrap do schema, gerencia sessão, carrega a base ativa,
 * autentica a requisição e despacha a ação por meio de um switch sobre
 * o parâmetro `action` (GET ou POST).
 *
 * Convenção de resposta: sempre JSON com `{ok: bool, ...}` salvo em
 * endpoints que produzem download binário (download_photo, download_bulk),
 * onde o Content-Type é substituído antes do echo.
 */
if (!defined('WEB_ROOT')) define('WEB_ROOT', dirname(__DIR__));
require_once __DIR__ . '/../../private-config/config.php';
require_once __DIR__ . '/../../private-config/lib/db.php';
require_once __DIR__ . '/../../private-config/lib/google.php';

/*
 * Bootstrap idempotente do schema para todas as bases configuradas.
 * Como cada base utiliza um prefixo de tabela próprio, é necessário
 * executar `DB::setup()` uma vez por base; o prefixo é restaurado para
 * vazio ao final e redefinido depois pela base ativa da sessão.
 */
try {
    foreach (BASES as $_baseKey => $_baseCfg) {
        DB::setPrefix($_baseCfg['db_prefix']);
        DB::setup();
    }
    DB::setPrefix('');
} catch (Throwable $e) {
    error_log('[banco-imagens] setup: ' . $e->getMessage());
}
unset($_baseKey, $_baseCfg);

/*
 * Sessão persistente em pasta dedicada fora do document root.
 * Permite controlar o TTL independentemente do garbage collector global
 * do servidor de hospedagem e impede acesso direto via HTTP mesmo na
 * eventualidade de um .htaccess inativo.
 */
$sessionDir = PRIVATE_CONFIG_PATH . '/sessions';
if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
ini_set('session.save_path',      $sessionDir);
ini_set('session.gc_maxlifetime', SESSION_LIFETIME);
ini_set('session.cookie_lifetime', SESSION_LIFETIME);
ini_set('session.use_strict_mode', '1');
ini_set('session.gc_probability',  '1');
ini_set('session.gc_divisor',      '100');
session_set_cookie_params([
    'lifetime' => SESSION_LIFETIME,
    'path'     => '/',
    'secure'   => isset($_SERVER['HTTPS']),
    'httponly' => true,
    'samesite' => 'Lax',
]);
session_name('bi_session');
session_start();

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');

$action = $_REQUEST['action'] ?? '';
$ip     = substr($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0', 0, 45);

/**
 * Resolve os dados (hash + role) do usuário considerando, em ordem:
 *   1. Sobrescritas dinâmicas em `users_override.json`.
 *   2. A constante `USERS` definida em `config.php`.
 * Em ambos os caminhos, eventuais sobrescritas de hash em
 * `passwords.json` substituem o hash original. Retorna null para
 * usuário inexistente.
 */
function getUserData(string $user): ?array {
    $usersPath = PRIVATE_CONFIG_PATH.'/users_override.json';
    if (file_exists($usersPath)) {
        $usersOvr = json_decode(file_get_contents($usersPath), true) ?? [];
        if (isset($usersOvr[$user])) return $usersOvr[$user];
    }
    if (!isset(USERS[$user])) return null;
    $u = USERS[$user];
    $base = is_array($u) ? $u : ['hash' => $u, 'role' => 'user'];
    $overridePath = PRIVATE_CONFIG_PATH.'/passwords.json';
    if (file_exists($overridePath)) {
        $overrides = json_decode(file_get_contents($overridePath), true) ?? [];
        if (isset($overrides[$user])) $base['hash'] = $overrides[$user];
    }
    return $base;
}

/** Indica se o usuário possui o papel `admin`. */
function isAdmin(string $user): bool {
    $d = getUserData($user);
    return $d && ($d['role'] ?? 'user') === 'admin';
}

/* -----------------------------------------------------------
 * Controle de acesso a bases de produção
 *
 * Administradores têm acesso a todas as bases por padrão. Demais
 * usuários só têm acesso às bases marcadas em `production_users.json`,
 * gerenciado pelo endpoint `set_production_access`.
 * --------------------------------------------------------- */

/** Retorna o mapa username → bool armazenado em `production_users.json`. */
function loadProductionUsers(): array {
    $path = PRIVATE_CONFIG_PATH.'/production_users.json';
    if (!file_exists($path)) return [];
    $data = json_decode(file_get_contents($path), true);
    return is_array($data) ? $data : [];
}
function saveProductionUsers(array $map): void {
    $path = PRIVATE_CONFIG_PATH.'/production_users.json';
    file_put_contents($path, json_encode($map, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE), LOCK_EX);
}
/** Indica se o usuário possui acesso às bases de produção. */
function hasProductionAccess(string $user): bool {
    if (isAdmin($user)) return true;
    $map = loadProductionUsers();
    return !empty($map[$user]);
}

/** Retorna a lista de chaves de `BASES` visíveis ao usuário. */
function visibleBaseKeys(string $user): array {
    $prodKeys = defined('PRODUCTION_BASES') ? PRODUCTION_BASES : [];
    $allKeys  = array_keys(BASES);
    if (isAdmin($user))             return $allKeys;
    if (hasProductionAccess($user)) return $allKeys;
    return array_values(array_filter($allKeys, fn($k)=>!in_array($k, $prodKeys, true)));
}

/** Indica se o usuário pode usar a base identificada por `$baseKey`. */
function userCanUseBase(string $user, string $baseKey): bool {
    return in_array($baseKey, visibleBaseKeys($user), true);
}

/**
 * Determina a base padrão exibida ao usuário no momento do login.
 * Usuários comuns sem acesso de produção são direcionados para TESTE
 * sempre que ela estiver disponível.
 */
function defaultBaseFor(string $user): string {
    $vis = visibleBaseKeys($user);
    if (isset(BASES['TESTE']) && in_array('TESTE',$vis,true) && !isAdmin($user) && !hasProductionAccess($user)) {
        return 'TESTE';
    }
    return $vis[0] ?? array_key_first(BASES);
}

/*
 * Endpoint `check_session` — chamado pelo frontend ao recarregar a
 * página para restaurar o estado da sessão sem forçar redirect.
 * Renova o timestamp e devolve metadados da base ativa.
 */
if ($action === 'check_session') {
    if (!empty($_SESSION['user'])) {
        $u = $_SESSION['user'];
        $loginTime = $_SESSION['login_time'] ?? 0;
        if ((time() - $loginTime) > SESSION_LIFETIME) {
            session_destroy();
            echo json_encode(['ok'=>false,'authenticated'=>false]);
        } else {
            $_SESSION['login_time'] = time();
            $sessionBase = $_SESSION['base'] ?? defaultBaseFor($u);
            if (!isset(BASES[$sessionBase]) || !userCanUseBase($u, $sessionBase)) {
                $sessionBase = defaultBaseFor($u);
                $_SESSION['base'] = $sessionBase;
            }
            session_write_close();
            $bCfg = BASES[$sessionBase];
            $isTestBase = !empty($bCfg['is_test']);
            echo json_encode([
                'ok'           => true,
                'authenticated'=> true,
                'user'         => $u,
                'role'         => getUserData($u)['role'] ?? 'user',
                'base'         => $sessionBase,
                'base_label'   => $bCfg['label'],
                'base_emoji'   => $bCfg['emoji'],
                'is_test_base' => $isTestBase,
                'has_prod'     => hasProductionAccess($u),
                'expires'      => time() + SESSION_LIFETIME,
                'warn_at'      => time() + SESSION_LIFETIME - SESSION_WARN_BEFORE,
            ]);
        }
    } else {
        echo json_encode(['ok'=>false,'authenticated'=>false]);
    }
    exit;
}

/*
 * Endpoint `login` — autentica usuário e estabelece a sessão.
 * Aplica rate limiting por IP e regenera o session id na autenticação
 * bem-sucedida para prevenir session fixation.
 */
if ($action === 'login') {
    try {
        if (DB::isBlocked($ip)) {
            $min = DB::blockRemaining($ip);
            http_response_code(429);
            echo json_encode(['ok'=>false,'error'=>"IP bloqueado por {$min} min."]);
            exit;
        }
    } catch (Throwable $e) {}

    $user = trim($_POST['user'] ?? '');
    $pass = $_POST['pass'] ?? '';
    $uData = getUserData($user);
    if ($uData && password_verify($pass, $uData['hash'])) {
        try { DB::clearFails($ip); } catch (Throwable $e) {}
        session_regenerate_id(true);
        $_SESSION['user']       = $user;
        $_SESSION['login_time'] = time();
        $visKeys = visibleBaseKeys($user);
        $hasProd = hasProductionAccess($user);
        $isAdminUser = isAdmin($user);
        $lastBase = $_SESSION['base'] ?? null;
        if ($lastBase && !in_array($lastBase, $visKeys, true)) $lastBase = null;
        // Usuários sem produção e com uma única base visível pulam o seletor.
        if (!$isAdminUser && !$hasProd && count($visKeys) === 1) {
            $_SESSION['base'] = $visKeys[0];
            $lastBase = $visKeys[0];
        } elseif (!$lastBase) {
            $_SESSION['base'] = null;
        }
        $basesList = [];
        foreach ($visKeys as $key) {
            $cfg = BASES[$key];
            $basesList[] = [
                'key'     => $key,
                'label'   => $cfg['label'],
                'emoji'   => $cfg['emoji'],
                'is_test' => !empty($cfg['is_test']),
            ];
        }
        echo json_encode([
            'ok'        => true,
            'user'      => $user,
            'role'      => $uData['role'] ?? 'user',
            'bases'     => $basesList,
            'last_base' => $lastBase,
            'has_prod'  => $hasProd,
            'expires'   => time()+SESSION_LIFETIME,
            'warn_at'   => time()+SESSION_LIFETIME-SESSION_WARN_BEFORE,
        ]);
    } else {
        try { DB::recordFail($ip); } catch (Throwable $e) {}
        http_response_code(401);
        echo json_encode(['ok'=>false,'error'=>'Usuário ou senha incorretos.']);
    }
    exit;
}

if ($action === 'logout') { session_destroy(); echo json_encode(['ok'=>true]); exit; }

if ($action === 'renew_session') {
    if (empty($_SESSION['user'])) { http_response_code(401); echo json_encode(['ok'=>false]); exit; }
    $_SESSION['login_time'] = time();
    session_write_close();
    echo json_encode([
        'ok'      => true,
        'expires' => time()+SESSION_LIFETIME,
        'warn_at' => time()+SESSION_LIFETIME-SESSION_WARN_BEFORE,
    ]);
    exit;
}

// Guard de autenticação aplicado a todos os endpoints abaixo.
if (empty($_SESSION['user'])) {
    http_response_code(401); echo json_encode(['ok'=>false,'error'=>'Não autenticado.']); exit;
}
if (isset($_SESSION['login_time']) && (time() - $_SESSION['login_time']) > SESSION_LIFETIME) {
    session_destroy(); http_response_code(401); echo json_encode(['ok'=>false,'error'=>'Sessão expirada.','expired'=>true]); exit;
}

$me      = $_SESSION['user'];
$meRole  = getUserData($me)['role'] ?? 'user';
$isAdmin = ($meRole === 'admin');

// Libera o lock de sessão para evitar serialização de requisições paralelas.
session_write_close();

// Carrega a base ativa a partir da sessão, com fallback para a base padrão do usuário.
$activeBase = $_SESSION['base'] ?? defaultBaseFor($me);
if (!isset(BASES[$activeBase]) || !userCanUseBase($me, $activeBase)) {
    $activeBase = defaultBaseFor($me);
}

$baseCfg = BASES[$activeBase];
$thumbDir     = $baseCfg['thumb_dir'];
$thumbBaseUrl = $baseCfg['thumb_base_url'];

DB::setPrefix($baseCfg['db_prefix']);

if (!is_dir($thumbDir)) @mkdir($thumbDir, 0755, true);

$api = new GoogleAPI($baseCfg);

/**
 * Bloqueio otimista por caso para serializar gravações concorrentes.
 *
 * Usa um arquivo de lock no diretório temporário do sistema. O lock
 * expira automaticamente após 10 segundos (caso o processo detentor
 * tenha morrido) e é liberado em `register_shutdown_function`.
 *
 * @return bool true quando o lock foi adquirido (ou herdado por expiração);
 *              false quando outro processo o detém ativamente.
 */
function acquireCaseLock(string $caso_id): bool {
    $lockFile = sys_get_temp_dir() . '/bi_lock_' . preg_replace('/[^A-Z0-9]/', '_', $caso_id) . '.lock';
    $fp = @fopen($lockFile, 'c+');
    if (!$fp) return true;
    $locked = flock($fp, LOCK_EX | LOCK_NB);
    if (!$locked) {
        $stat = fstat($fp);
        if ($stat && (time() - $stat['mtime']) > 10) {
            flock($fp, LOCK_UN);
            @unlink($lockFile);
            return true;
        }
        fclose($fp);
        return false;
    }
    fwrite($fp, (string)time());
    fflush($fp);
    register_shutdown_function(function() use ($fp, $lockFile) {
        @flock($fp, LOCK_UN);
        @fclose($fp);
        @unlink($lockFile);
    });
    return true;
}

function thumbUrl(?string $f): ?string {
    global $thumbDir, $thumbBaseUrl;
    if (!$f) return null;
    return file_exists($thumbDir.'/'.$f) ? $thumbBaseUrl.'/'.$f : null;
}
function enrichPhotos(array $photos): array {
    foreach ($photos as &$p) $p['thumb_url'] = thumbUrl($p['local_thumb'] ?? null);
    return $photos;
}

/** Aborta com HTTP 403 quando a ação requer privilégio de administrador. */
function requireAdmin(bool $isAdmin): void {
    if (!$isAdmin) {
        http_response_code(403);
        echo json_encode(['ok'=>false,'error'=>'Acesso restrito a administradores.']);
        exit;
    }
}

switch ($action) {

    // ── Diagnóstico ───────────────────────────────────────
    case 'diagnostico':
        requireAdmin($isAdmin);
        $r = [];
        $r['php'] = [
            'ok'              => true,
            'version'         => PHP_VERSION,
            'openssl'         => extension_loaded('openssl')   ? '✓' : '❌ Ausente',
            'allow_url_fopen' => ini_get('allow_url_fopen')    ? '✓' : '❌ Desativado',
            'pdo_mysql'       => extension_loaded('pdo_mysql') ? '✓' : '❌ Ausente',
            'thumb_dir'       => (is_dir($thumbDir) && is_writable($thumbDir)) ? '✓ '.$thumbDir : '❌ '.$thumbDir.' — sem permissão',
        ];
        try { DB::get(); $r['mysql'] = ['ok'=>true,'msg'=>'✓ Conexão OK']; }
        catch (Throwable $e) { $r['mysql'] = ['ok'=>false,'msg'=>'❌ '.$e->getMessage()]; }

        // Confirma a existência e o funcionamento da tabela de auditoria.
        if ($r['mysql']['ok']) {
            try {
                $cnt = DB::get()->query("SELECT COUNT(*) FROM ".DB::getPrefix()."audit_log")->fetchColumn();
                $r['audit_log'] = ['ok'=>true,'msg'=>"✓ Tabela OK — {$cnt} registros"];
            } catch (Throwable $e) {
                $r['audit_log'] = ['ok'=>false,'msg'=>'❌ Tabela audit_log: '.$e->getMessage()];
            }
        }

        if (!file_exists(GOOGLE_CREDENTIALS_PATH)) {
            $r['credentials'] = ['ok'=>false,'msg'=>'❌ Não encontrado'];
        } else {
            $c = json_decode(file_get_contents(GOOGLE_CREDENTIALS_PATH), true);
            $r['credentials'] = isset($c['client_email'])
                ? ['ok'=>true,'msg'=>'✓ '.$c['client_email']]
                : ['ok'=>false,'msg'=>'❌ JSON inválido'];
        }
        $r['config'] = [
            'ok'              => true,
            'spreadsheet_id'  => '✓ '.substr($baseCfg['spreadsheet_id'],0,15).'...',
            'drive_folder_id' => '✓ '.substr($baseCfg['drive_folder_id'],0,15).'...',
            'sheet_name'      => $baseCfg['sheet_name'],
        ];
        try { $api->getAccessTokenPublic(); $r['google_auth'] = ['ok'=>true,'msg'=>'✓ Token OK']; }
        catch (Throwable $e) { $r['google_auth'] = ['ok'=>false,'msg'=>'❌ '.$e->getMessage()]; }

        if ($r['google_auth']['ok'] ?? false) {
            try { $casos=$api->getCasos(); $r['sheets']=['ok'=>true,'msg'=>'✓ '.count($casos).' casos']; }
            catch (Throwable $e) { $r['sheets']=['ok'=>false,'msg'=>'❌ '.$e->getMessage()]; }
            try {
                $ids   = $api->getAllFolderIds();
                $files = $api->listDriveFolder(5);
                $r['drive'] = ['ok'=>true,'msg'=>'✓ '.count($ids).' pasta(s). Primeiros: '.implode(', ',array_column($files,'name'))];
            } catch (Throwable $e) { $r['drive']=['ok'=>false,'msg'=>'❌ '.$e->getMessage()]; }
        } else {
            $r['sheets'] = $r['drive'] = ['ok'=>false,'msg'=>'Não testado'];
        }

        try {
            $tc = DB::get()->query("SELECT COUNT(*) FROM thumb_cache")->fetchColumn();
            $tf = is_dir($thumbDir) ? count(glob($thumbDir.'/*.{jpg,webp}', GLOB_BRACE)) : 0;
            $r['cache_stats'] = ['ok'=>true,'msg'=>"Casos em cache: {$tc} | Arquivos /thumbs/: {$tf}"];
        } catch (Throwable $e) { $r['cache_stats'] = ['ok'=>false,'msg'=>'—']; }

        echo json_encode(['ok'=>true,'result'=>$r]);
        break;

    // Diagnóstico do registro de auditoria: grava uma entrada e devolve a última linha gravada.
    case 'test_log':
        try {
            DB::log($me, 'TESTE-000', 'test', ['info'=>'antes'], ['info'=>'depois']);
            $last = DB::get()->query("SELECT * FROM ".DB::getPrefix()."audit_log ORDER BY id DESC LIMIT 1")->fetch();
            echo json_encode(['ok'=>true,'msg'=>'Log de teste gravado.','last'=>$last]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
        }
        break;

    // ── Casos ─────────────────────────────────────────────
    case 'casos':
        try {
            $casos = $api->getCasos(!empty($_GET['force']));
            $profs = [];
            foreach ($casos as $c) foreach ($c['clientes'] as $p) if ($p) $profs[$p] = true;
            $profList = array_keys($profs); sort($profList);
            echo json_encode(['ok'=>true,'casos'=>$casos,'total'=>count($casos),'profissionais'=>$profList]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Listagem de fotos para um caso, com override opcional da fonte (cache vs. Drive).
    case 'photos':
        $id    = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_GET['id']??''));
        $force = !empty($_GET['force']);
        // Aceita 'auto' | 'cache' | 'drive' para diagnósticos comparativos.
        $source = $_GET['source'] ?? 'auto';
        if ($source === 'drive') $force = true;
        if (!$id) { echo json_encode(['ok'=>false,'error'=>'ID inválido.','photos'=>[]]); break; }
        try {
            if ($source === 'cache') {
                $cached = DB::getThumbCache($id);
                if (!$cached) { echo json_encode(['ok'=>false,'error'=>'Não há cache para este caso.','photos'=>[]]); break; }
                echo json_encode(['ok'=>true,'photos'=>enrichPhotos($cached),'source'=>'cache']);
            } else {
                $photos = enrichPhotos($api->getDrivePhotos($id, $force));
                $src = ($force && $source==='drive') ? 'drive' : (DB::getThumbCache($id)!==null ? 'cache' : 'drive');
                echo json_encode(['ok'=>true,'photos'=>$photos,'source'=>$src]);
            }
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'photos'=>[]]); }
        break;

    // Troca a base ativa da sessão e já devolve os casos da nova base na mesma resposta.
    case 'switch_base':
        $newBase = strtoupper(trim($_POST['base'] ?? ''));
        if (!isset(BASES[$newBase])) {
            echo json_encode(['ok'=>false,'error'=>'Base inválida.']); break;
        }
        if (!userCanUseBase($me, $newBase)) {
            http_response_code(403);
            echo json_encode(['ok'=>false,'error'=>'Você não tem acesso a esta base.']); break;
        }
        // Reabre a sessão para gravação após o session_write_close global.
        session_start();
        $_SESSION['base'] = $newBase;
        session_write_close();

        $cfg = BASES[$newBase];
        DB::setPrefix($cfg['db_prefix']);
        $switchApi = new GoogleAPI($cfg);
        try {
            $casos    = $switchApi->getCasos(false);
            $profs    = [];
            foreach ($casos as $c) foreach ($c['clientes'] as $p) if ($p) $profs[$p] = true;
            $profList = array_keys($profs); sort($profList);
            echo json_encode([
                'ok'            => true,
                'base'          => $newBase,
                'label'         => $cfg['label'],
                'emoji'         => $cfg['emoji'],
                'is_test'       => !empty($cfg['is_test']),
                'casos'         => $casos,
                'total'         => count($casos),
                'profissionais' => $profList,
            ]);
        } catch (Throwable $e) {
            // A sessão já foi persistida — devolvemos OK e o frontend fará o reload dos casos.
            echo json_encode([
                'ok'         => true,
                'base'       => $newBase,
                'label'      => $cfg['label'],
                'emoji'      => $cfg['emoji'],
                'is_test'    => !empty($cfg['is_test']),
                'casos'      => null,
                'error_casos'=> $e->getMessage(),
            ]);
        }
        break;

    // ── Lista bases disponíveis (filtradas por permissão) ─────
    case 'get_bases':
        $list = [];
        foreach (visibleBaseKeys($me) as $key) {
            $cfg = BASES[$key];
            $list[] = [
                'key'     => $key,
                'label'   => $cfg['label'],
                'emoji'   => $cfg['emoji'],
                'is_test' => !empty($cfg['is_test']),
                'active'  => ($key===$activeBase),
            ];
        }
        echo json_encode(['ok'=>true,'bases'=>$list,'active'=>$activeBase,'has_prod'=>hasProductionAccess($me)]);
        break;

    case 'cache_status':
        $idsRaw = $_GET['ids'] ?? '';
        $ids = array_filter(array_map('trim', explode(',', $idsRaw)), fn($x)=>preg_match('/^CASO-\d+$/',$x));
        if (!$ids) { echo json_encode(['ok'=>false,'error'=>'IDs inválidos']); break; }
        try {
            $result = [];
            foreach ($ids as $cid) {
                $cached = DB::getThumbCache($cid);
                if ($cached !== null) {
                    $best = null;
                    foreach ($cached as $p) {
                        if (empty($p['local_thumb'])) continue;
                        $path = $thumbDir.'/'.$p['local_thumb'];
                        if (file_exists($path)) { $best = $thumbBaseUrl.'/'.$p['local_thumb']; break; }
                    }
                    // null indica registro em cache de banco sem arquivo físico em disco.
                    $result[$cid] = $best;
                }
            }
            echo json_encode(['ok'=>true,'cache'=>$result]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // ── Novos arquivos ────────────────────────────────────
    case 'new_files':
        try { $f=$api->getDriveNewFiles(7); echo json_encode(['ok'=>true,'files'=>$f,'count'=>count($f)]); }
        catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'count'=>0]); }
        break;

    // ── Histórico ─────────────────────────────────────────
    case 'historico':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_GET['caso_id']??''));
        $usuario = preg_replace('/[^a-zA-Z0-9_]/','',$_GET['usuario']??'');
        $limit   = min(500, max(10, (int)($_GET['limit']??200)));
        try {
            $log = DB::getLog($limit, $caso_id, $usuario);
            foreach ($log as &$e) {
                if (!empty($e['antes_json']))  $e['antes']  = json_decode($e['antes_json'],  true);
                if (!empty($e['depois_json'])) $e['depois'] = json_decode($e['depois_json'], true);
                unset($e['antes_json'], $e['depois_json']);
            }
            echo json_encode(['ok'=>true,'log'=>$log,'count'=>count($log)]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'log'=>[]]); }
        break;

    // ── Add uso ───────────────────────────────────────────
    case 'add_uso':
        $caso_id  = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row      = (int)($_POST['row']??0);
        $nova_uf  = strtoupper(trim($_POST['uf']??''));
        $nova_cid = strtoupper(trim($_POST['cidade']??''));
        $prof     = trim($_POST['profissional']??'');
        $force    = !empty($_POST['force']);
        // O frontend envia o estado atual para evitar um round-trip ao Sheets.
        $cur_ufs   = array_filter(array_map('trim', explode('/', $_POST['cur_ufs']??'')));
        $cur_cids  = array_filter(array_map('trim', explode('/', $_POST['cur_cids']??'')));
        $cur_clis  = array_filter(array_map('trim', explode('/', $_POST['cur_clis']??'')));

        if (!$caso_id||!$row||!$nova_uf||!$nova_cid||!$prof) {
            echo json_encode(['ok'=>false,'error'=>'Preencha todos os campos.']); break;
        }
        try {
            $casos = $api->getCasos(false); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            // Quando o estado é enviado pelo cliente, ele é considerado a fonte mais fresca.
            if ($caso && !empty($cur_ufs)) {
                $caso['ufs']     = array_values($cur_ufs);
                $caso['cidades'] = array_values($cur_cids);
                $caso['clientes']= array_values($cur_clis);
            }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }

            // Casos com flag de bloqueio não recebem novos usos.
            if (!empty($caso['bloqueado'])) {
                $motivo = trim($caso['motivo_bloqueio'] ?? '');
                $msg = 'Caso BLOQUEADO — não pode receber novos usos.';
                if ($motivo !== '') $msg .= ' Motivo: '.$motivo;
                echo json_encode(['ok'=>false,'error'=>$msg]); break;
            }

            // Cidade duplicada é hard-error: não há justificativa para repetição na mesma cidade.
            if (in_array($nova_cid, $caso['cidades'])) {
                echo json_encode(['ok'=>false,'error'=>'Cidade '.ucwords(strtolower($nova_cid)).' já está em uso neste caso.']); break;
            }

            // Estado duplicado dispara warning (precisa confirmação explícita via `force`).
            if (!$force && in_array($nova_uf, $caso['ufs'])) {
                $profsNoEstado = [];
                foreach ($caso['ufs'] as $i => $uf) {
                    if ($uf === $nova_uf)
                        $profsNoEstado[] = ($caso['clientes'][$i]??'?').' / '.ucwords(strtolower($caso['cidades'][$i]??''));
                }
                echo json_encode(['ok'=>false,'warn'=>true,'msg'=>
                    "ATENÇÃO: {$caso_id} já está em uso no estado {$nova_uf} por: ".implode(', ',$profsNoEstado).". Deseja continuar mesmo assim?"
                ]);
                break;
            }

            $antes  = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $nufs   = array_merge($caso['ufs'],     [$nova_uf]);
            $ncids  = array_merge($caso['cidades'],  [$nova_cid]);
            $nclis  = array_merge($caso['clientes'], [$prof]);

            // Lock otimista para evitar gravações simultâneas no mesmo caso.
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']);
                break;
            }
            // Recarrega do Sheets para detectar conflitos posteriores ao caching local.
            DB::clearSheetCache();
            $casosAtual = $api->getCasos(true);
            $casoAtual = null;
            foreach ($casosAtual as $c) { if ($c['id']===$caso_id) { $casoAtual=$c; break; } }
            if ($casoAtual && in_array($nova_cid, $casoAtual['cidades'])) {
                echo json_encode(['ok'=>false,'error'=>'Conflito: a cidade '.ucwords(strtolower($nova_cid)).' foi registrada por outro usuário. Atualize e tente novamente.']);
                break;
            }

            // Grava na planilha. O log de auditoria só é registrado após o sucesso da escrita.
            $api->updateCaso($row, implode('/',$nufs), implode('/',$ncids), implode('/',$nclis));
            DB::log($me, $caso_id, 'add_uso', $antes, ['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis]);

            echo json_encode(['ok'=>true,'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis]]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
        }
        break;

    // ── Remove uso ────────────────────────────────────────
    case 'remove_uso':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $idx     = (int)($_POST['idx']??-1);

        if (!$caso_id||!$row||$idx<0) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            $casos = $api->getCasos(); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!isset($caso['ufs'][$idx])) { echo json_encode(['ok'=>false,'error'=>'Índice inválido.']); break; }

            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $ufs=$caso['ufs']; $cids=$caso['cidades']; $clis=$caso['clientes'];
            array_splice($ufs,$idx,1); array_splice($cids,$idx,1); array_splice($clis,$idx,1);

            $api->updateCaso($row, implode('/',$ufs), implode('/',$cids), implode('/',$clis));
            DB::log($me, $caso_id, 'remove_uso', $antes, ['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis]);

            echo json_encode(['ok'=>true,'depois'=>['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis]]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
        }
        break;

    /*
     * Remove um item isolado (uma UF, uma cidade ou um cliente) por valor,
     * sem afetar os arrays paralelos. Quando o índice é fornecido, ele
     * tem precedência para desambiguar duplicatas.
     */
    case 'remove_item':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $tipo    = $_POST['tipo']??'';   // 'uf' | 'cidade' | 'cliente'
        $valor   = trim($_POST['valor']??'');
        $idx     = isset($_POST['idx']) ? (int)$_POST['idx'] : -1; // índice opcional para desambiguar duplicatas

        if (!$caso_id||!$row||!in_array($tipo,['uf','cidade','cliente'])||$valor==='') {
            echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break;
        }
        try {
            $casos = $api->getCasos(); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }

            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $ufs   = $caso['ufs'];
            $cids  = $caso['cidades'];
            $clis  = $caso['clientes'];

            // Quando $idx é informado, remove pelo índice (preciso para duplicatas);
            // caso contrário, remove a primeira ocorrência do valor.
            if ($tipo === 'uf') {
                if ($idx >= 0 && isset($ufs[$idx])) { array_splice($ufs,$idx,1); }
                else { $pos=array_search(strtoupper($valor),$ufs); if($pos!==false) array_splice($ufs,$pos,1); }
            } elseif ($tipo === 'cidade') {
                if ($idx >= 0 && isset($cids[$idx])) { array_splice($cids,$idx,1); }
                else { $pos=array_search(strtoupper($valor),$cids); if($pos!==false) array_splice($cids,$pos,1); }
            } elseif ($tipo === 'cliente') {
                if ($idx >= 0 && isset($clis[$idx])) { array_splice($clis,$idx,1); }
                else { $pos=array_search($valor,$clis); if($pos!==false) array_splice($clis,$pos,1); }
            }

            $api->updateCaso($row, implode('/',$ufs), implode('/',$cids), implode('/',$clis));
            DB::log($me, $caso_id, 'remove_'.$tipo, $antes, ['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis]);

            echo json_encode(['ok'=>true,'depois'=>['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis]]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
        }
        break;

    // ── Limpar cache ──────────────────────────────────────
    case 'clear_cache':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        try {
            if ($caso_id) {
                $raw = DB::getThumbCacheRaw($caso_id);
                DB::clearThumbCache($caso_id);
                foreach (json_decode($raw??'[]', true)??[] as $p)
                    if (!empty($p['local_thumb'])) @unlink($thumbDir.'/'.$p['local_thumb']);
                echo json_encode(['ok'=>true,'msg'=>"Cache do {$caso_id} limpo."]);
            } else {
                DB::clearThumbCache();
                DB::clearFolderCache();
                DB::clearSheetCache();
                $deleted = 0;
                if (is_dir($thumbDir))
                    foreach (glob($thumbDir.'/*.{jpg,webp}', GLOB_BRACE) as $f) { @unlink($f); $deleted++; }
                echo json_encode(['ok'=>true,'msg'=>"Cache limpo. {$deleted} thumbs removidas."]);
            }
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Reverte um caso para um estado anterior identificado pelo histórico de auditoria (admin).
    case 'revert_caso':
        requireAdmin($isAdmin);
        $caso_id  = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row      = (int)($_POST['row']??0);
        $ufs_str  = trim($_POST['ufs']??'');
        $cids_str = trim($_POST['cidades']??'');
        $clis_str = trim($_POST['clientes']??'');
        if (!$caso_id||!$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            $casos = $api->getCasos();
            $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $api->updateCaso($row, $ufs_str, $cids_str, $clis_str);
            $nufs  = $ufs_str  ? array_values(array_filter(array_map('trim',explode('/',$ufs_str))))  : [];
            $ncids = $cids_str ? array_values(array_filter(array_map('trim',explode('/',$cids_str)))) : [];
            $nclis = $clis_str ? array_values(array_filter(array_map('trim',explode('/',$clis_str)))) : [];
            DB::log($me, $caso_id, 'revert', $antes, ['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis]);
            echo json_encode(['ok'=>true]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Mede o tempo de resposta de uma busca via Drive vs. cache local (admin).
    case 'speed_test':
        requireAdmin($isAdmin);
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_GET['id']??''));
        if (!$caso_id) { echo json_encode(['ok'=>false,'error'=>'ID inválido']); break; }
        $t0 = microtime(true);
        try {
            // 1) Drive sem cache.
            $photos = $api->getDrivePhotos($caso_id, true);
            $t_drive = round((microtime(true)-$t0)*1000);
            $photos_enriched = enrichPhotos($photos);
            $has_local = !empty($photos_enriched[0]['thumb_url']);
            $t1 = microtime(true);
            // 2) Cache local (quando existente).
            $cached = DB::getThumbCache($caso_id);
            $t_cache = $cached ? round((microtime(true)-$t1)*1000) : null;
            echo json_encode([
                'ok'       => true,
                'case'     => $caso_id,
                'drive_ms' => $t_drive,
                'cache_ms' => $t_cache,
                'has_local_thumb' => $has_local,
                'photo_count' => count($photos),
                'recommendation' => $has_local && $t_cache < $t_drive ? 'cache' : 'drive',
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Lista todos os usuários conhecidos com metadados de uso (admin).
    case 'list_users':
        requireAdmin($isAdmin);
        $list = [];
        // Combina USERS estáticos com sobrescritas dinâmicas em users_override.json.
        $allUsers = USERS;
        $usersPath = PRIVATE_CONFIG_PATH.'/users_override.json';
        if (file_exists($usersPath)) {
            $usersOvr = json_decode(file_get_contents($usersPath), true) ?? [];
            foreach ($usersOvr as $u => $d) {
                if (!isset($allUsers[$u])) $allUsers[$u] = $d;
            }
        }
        $prodMap = loadProductionUsers();
        foreach ($allUsers as $u => $d) {
            $data = is_array($d) ? $d : ['hash'=>$d,'role'=>'user'];
            try {
                $llSt = DB::get()->prepare("SELECT MAX(criado_em) as last FROM ".DB::getPrefix()."audit_log WHERE usuario=? AND acao='login_success'");
                $llSt->execute([$u]);
                $ll = $llSt->fetch()['last'] ?? null;
                $chSt = DB::get()->prepare("SELECT COUNT(*) FROM ".DB::getPrefix()."audit_log WHERE usuario=? AND criado_em > DATE_SUB(NOW(), INTERVAL 30 DAY) AND acao NOT IN ('login_success')");
                $chSt->execute([$u]);
                $c30 = $chSt->fetchColumn();
            } catch (Throwable $e) { $ll = null; $c30 = 0; }
            $role = $data['role'] ?? 'user';
            $list[] = [
                'user'        => $u,
                'role'        => $role,
                'last_login'  => $ll,
                'changes_30d' => (int)$c30,
                // Admin tem acesso de produção implícito; demais dependem do mapa.
                'prod_access' => ($role === 'admin') || !empty($prodMap[$u]),
            ];
        }
        echo json_encode(['ok'=>true,'users'=>$list]);
        break;

    // ── Promover/rebaixar acesso a bases de produção ─────────
    case 'set_production_access':
        requireAdmin($isAdmin);
        $target = trim($_POST['target_user'] ?? '');
        $allow  = !empty($_POST['allow']) && $_POST['allow'] !== '0' && $_POST['allow'] !== 'false';
        if (!$target) { echo json_encode(['ok'=>false,'error'=>'Usuário não especificado.']); break; }
        $targetData = getUserData($target);
        if (!$targetData) { echo json_encode(['ok'=>false,'error'=>'Usuário não encontrado.']); break; }
        // Administradores já têm acesso pleno; alterar a flag não tem efeito.
        if (($targetData['role'] ?? 'user') === 'admin') {
            echo json_encode(['ok'=>true,'msg'=>'Admins já têm acesso a todas as bases.']); break;
        }
        $map = loadProductionUsers();
        if ($allow) $map[$target] = true; else unset($map[$target]);
        saveProductionUsers($map);
        DB::log($me, 'sistema', 'set_production_access', ['user'=>$target], ['prod_access'=>$allow]);
        echo json_encode(['ok'=>true,'msg'=>$allow?"'{$target}' agora tem acesso à produção.":"'{$target}' voltou ao modo teste."]);
        break;

    case 'change_password':
        requireAdmin($isAdmin);
        $target = trim($_POST['target_user']??'');
        $newpass = $_POST['new_password']??'';
        if (!$target) { echo json_encode(['ok'=>false,'error'=>'Usuário não especificado.']); break; }
        // Salvaguarda: um admin não pode alterar a senha de outro admin.
        $targetData = getUserData($target);
        if ($targetData && ($targetData['role']??'user') === 'admin' && $target !== $me) {
            echo json_encode(['ok'=>false,'error'=>'Não é possível alterar a senha de outro administrador.']); break;
        }
        if (strlen($newpass) < 6) { echo json_encode(['ok'=>false,'error'=>'Senha muito curta.']); break; }
        $overridePath = PRIVATE_CONFIG_PATH.'/passwords.json';
        $overrides = file_exists($overridePath) ? json_decode(file_get_contents($overridePath),true) : [];
        $overrides[$target] = password_hash($newpass, PASSWORD_DEFAULT);
        file_put_contents($overridePath, json_encode($overrides, JSON_PRETTY_PRINT), LOCK_EX);
        DB::log($me, 'sistema', 'change_password', ['user'=>$target], ['changed'=>true]);
        echo json_encode(['ok'=>true,'msg'=>"Senha de '{$target}' alterada."]);
        break;

    // Cria um usuário dinâmico em users_override.json (admin).
    case 'add_user':
        requireAdmin($isAdmin);
        $newUser = trim($_POST['new_user']??'');
        $newPass = $_POST['new_password']??'';
        $newRole = in_array($_POST['role']??'',['admin','user']) ? $_POST['role'] : 'user';
        if (!preg_match('/^[a-z0-9_]{3,30}$/',$newUser)) { echo json_encode(['ok'=>false,'error'=>'Nome de usuário inválido.']); break; }
        if (isset(USERS[$newUser])) { echo json_encode(['ok'=>false,'error'=>'Usuário já existe no config.php.']); break; }
        if (strlen($newPass) < 6) { echo json_encode(['ok'=>false,'error'=>'Senha muito curta.']); break; }
        $usersPath = PRIVATE_CONFIG_PATH.'/users_override.json';
        $usersOvr  = file_exists($usersPath) ? json_decode(file_get_contents($usersPath),true) : [];
        $usersOvr[$newUser] = ['hash'=>password_hash($newPass,PASSWORD_DEFAULT),'role'=>$newRole];
        file_put_contents($usersPath, json_encode($usersOvr, JSON_PRETTY_PRINT), LOCK_EX);
        DB::log($me, 'sistema', 'add_user', null, ['user'=>$newUser,'role'=>$newRole]);
        echo json_encode(['ok'=>true,'msg'=>"Usuário '{$newUser}' criado."]);
        break;

    /*
     * Remove um usuário dinâmico (admin). Apenas remove de
     * `users_override.json`; usuários definidos em `config.php` não
     * podem ser removidos por esta via, apenas editados manualmente.
     */
    case 'remove_user':
        requireAdmin($isAdmin);
        $target = trim($_POST['target_user']??'');
        if (!$target) { echo json_encode(['ok'=>false,'error'=>'Usuário não especificado.']); break; }
        $targetData = getUserData($target);
        if ($targetData && ($targetData['role']??'user') === 'admin') {
            echo json_encode(['ok'=>false,'error'=>'Não é possível remover um administrador.']); break;
        }
        $usersPath = PRIVATE_CONFIG_PATH.'/users_override.json';
        $usersOvr  = file_exists($usersPath) ? json_decode(file_get_contents($usersPath),true) : [];
        unset($usersOvr[$target]);
        file_put_contents($usersPath, json_encode($usersOvr, JSON_PRETTY_PRINT), LOCK_EX);
        DB::log($me, 'sistema', 'remove_user', ['user'=>$target], null);
        echo json_encode(['ok'=>true]);
        break;

    /*
     * Bloqueia um caso para uso. Insere o marcador "NA" no array de UFs
     * e grava o motivo na coluna G. Cidades e clientes preexistentes
     * são preservados para que o desbloqueio recomponha o estado.
     */
    case 'set_block':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $motivo  = trim($_POST['motivo']??'');
        if (!$caso_id || !$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        if ($motivo === '') { echo json_encode(['ok'=>false,'error'=>'O motivo é obrigatório para bloquear.']); break; }
        if (mb_strlen($motivo) > 250) $motivo = mb_substr($motivo, 0, 250);
        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Caso sendo editado por outro usuário. Tente novamente.']); break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!empty($caso['bloqueado'])) {
                echo json_encode(['ok'=>false,'error'=>'Caso já está bloqueado.']); break;
            }
            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes'],'motivo_bloqueio'=>$caso['motivo_bloqueio']??''];
            // O marcador "NA" é acrescentado apenas ao array de UFs como flag
            // de status; getCasos() já tolera a quebra de paridade entre arrays.
            $nufs   = array_merge($caso['ufs'], ['NA']);
            $ncids  = $caso['cidades'];
            $nclis  = $caso['clientes'];
            $tags   = implode('/', $caso['tags'] ?? []);
            // Escrita atômica de C:G para evitar estados parciais.
            $api->updateCaso($row, implode('/',$nufs), implode('/',$ncids), implode('/',$nclis), $tags, $motivo);
            DB::log($me, $caso_id, 'block', $antes, ['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'motivo_bloqueio'=>$motivo,'bloqueado'=>true]);
            echo json_encode([
                'ok'=>true,
                'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'tags'=>$caso['tags']??[],'motivo_bloqueio'=>$motivo,'bloqueado'=>true]
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // ── Desbloquear caso (admin only) ─────────────────────────
    case 'unblock_case':
        requireAdmin($isAdmin);
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        if (!$caso_id || !$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Caso sendo editado por outro usuário.']); break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (empty($caso['bloqueado'])) {
                echo json_encode(['ok'=>false,'error'=>'Caso não está bloqueado.']); break;
            }
            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes'],'motivo_bloqueio'=>$caso['motivo_bloqueio']??''];
            // Remove todos os marcadores de bloqueio do array de UFs e limpa
            // o motivo na coluna G; cidades e clientes refletem usos reais
            // e permanecem intactos.
            $nufs  = array_values(array_filter($caso['ufs'], fn($u) => !GoogleAPI::isBlockMarker($u)));
            $ncids = $caso['cidades'];
            $nclis = $caso['clientes'];
            $tags  = implode('/', $caso['tags'] ?? []);
            $api->updateCaso($row, implode('/',$nufs), implode('/',$ncids), implode('/',$nclis), $tags, '');
            DB::log($me, $caso_id, 'unblock', $antes, ['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'motivo_bloqueio'=>'','bloqueado'=>false]);
            echo json_encode([
                'ok'=>true,
                'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'tags'=>$caso['tags']??[],'motivo_bloqueio'=>'','bloqueado'=>false]
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Adiciona uma tag ao caso. Aceita letras, números, espaço, &, + e -; máx. 30 caracteres.
    case 'add_tag':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $tag     = strtoupper(trim($_POST['tag']??''));
        $tag = preg_replace('/[^A-Z0-9 \&\+\-]/u','',$tag);
        $tag = trim(preg_replace('/\s+/',' ',$tag));
        if (!$caso_id || !$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        if ($tag === '' || mb_strlen($tag) > 30) { echo json_encode(['ok'=>false,'error'=>'Tag inválida (1–30 caracteres).']); break; }
        try {
            $casos = $api->getCasos(false); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            $cur = $caso['tags'] ?? [];
            if (in_array($tag, $cur, true)) { echo json_encode(['ok'=>true,'tags'=>$cur,'msg'=>'Tag já existe.']); break; }
            if (count($cur) >= 20) { echo json_encode(['ok'=>false,'error'=>'Máximo de 20 tags por caso.']); break; }
            $nv = array_values(array_merge($cur, [$tag]));
            $api->updateCasoTags($row, implode('/', $nv));
            DB::log($me, $caso_id, 'add_tag', ['tags'=>$cur], ['tags'=>$nv]);
            echo json_encode(['ok'=>true,'tags'=>$nv]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Remove uma tag do caso (idempotente: tag inexistente devolve a lista atual).
    case 'remove_tag':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $tag     = strtoupper(trim($_POST['tag']??''));
        if (!$caso_id || !$row || $tag === '') { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            $casos = $api->getCasos(false); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            $cur = $caso['tags'] ?? [];
            $nv  = array_values(array_filter($cur, fn($t)=>$t !== $tag));
            if (count($nv) === count($cur)) { echo json_encode(['ok'=>true,'tags'=>$cur,'msg'=>'Tag não estava presente.']); break; }
            $api->updateCasoTags($row, implode('/', $nv));
            DB::log($me, $caso_id, 'remove_tag', ['tags'=>$cur], ['tags'=>$nv]);
            echo json_encode(['ok'=>true,'tags'=>$nv]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); }
        break;

    // Tags únicas em todos os casos (consumido pelo autocomplete da interface).
    case 'list_tags':
        try {
            $casos = $api->getCasos(false);
            $set = [];
            foreach ($casos as $c) foreach (($c['tags']??[]) as $t) if ($t !== '') $set[$t] = true;
            $list = array_keys($set); sort($list);
            echo json_encode(['ok'=>true,'tags'=>$list]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'tags'=>[]]); }
        break;

    // ── Download direto de uma foto/arquivo do Drive ───────────
    case 'download_photo':
        $fileId = preg_replace('/[^A-Za-z0-9_\-]/','',$_GET['file_id']??'');
        if (!$fileId) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'file_id inválido.']); break; }
        try {
            $r = $api->downloadDriveFile($fileId);
            if (!$r['ok']) { http_response_code(502); echo json_encode(['ok'=>false,'error'=>$r['error']??'Falha']); break; }
            // Substitui os headers JSON padrão por headers de download.
            header_remove('Content-Type');
            header_remove('X-Frame-Options');
            // Sanitiza o filename ASCII com fallback RFC 5987 para caracteres unicode.
            $safeName = preg_replace('/[^A-Za-z0-9._\- ]/u','_', $r['name']);
            header('Content-Type: '.$r['mime']);
            header('Content-Length: '.strlen($r['data']));
            header('Content-Disposition: attachment; filename="'.$safeName.'"; filename*=UTF-8\'\''.rawurlencode($r['name']));
            header('Cache-Control: private, max-age=300');
            echo $r['data'];
            DB::log($me, 'sistema', 'download_photo', null, ['file_id'=>$fileId,'name'=>$r['name']]);
            exit;
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]);
        }
        break;

    // ── Download em lote: ZIP com até 30 casos ─────────────────
    case 'download_bulk':
        if (!class_exists('ZipArchive')) { echo json_encode(['ok'=>false,'error'=>'ZipArchive não disponível neste servidor.']); break; }
        $idsRaw = $_POST['ids'] ?? '';
        $ids = array_values(array_filter(
            array_map('trim', explode(',', $idsRaw)),
            fn($x)=>preg_match('/^CASO-\d+$/', $x)
        ));
        $ids = array_values(array_unique(array_map('strtoupper', $ids)));
        if (!$ids) { echo json_encode(['ok'=>false,'error'=>'Nenhum ID válido informado.']); break; }
        if (count($ids) > 30) { echo json_encode(['ok'=>false,'error'=>'Máximo 30 casos por download.']); break; }
        $tmpZip = tempnam(sys_get_temp_dir(), 'bi_zip_');
        $zip = new ZipArchive();
        if ($zip->open($tmpZip, ZipArchive::OVERWRITE) !== true) {
            @unlink($tmpZip);
            echo json_encode(['ok'=>false,'error'=>'Falha ao criar ZIP.']); break;
        }
        $errors = [];
        $totalFiles = 0;
        try {
            foreach ($ids as $cid) {
                try {
                    $photos = $api->getDrivePhotos($cid, false);
                } catch (Throwable $e) {
                    $errors[] = "$cid: ".$e->getMessage(); continue;
                }
                if (!$photos) { $errors[] = "$cid: sem fotos"; continue; }
                // Inclui o arquivo completo (não a thumbnail) de cada foto.
                foreach ($photos as $p) {
                    $r = $api->downloadDriveFile($p['id']);
                    if (!$r['ok']) { $errors[] = "$cid/{$p['name']}: ".($r['error']??'falha'); continue; }
                    $entry = $cid.'/'.preg_replace('/[\\\\\/:*?"<>|]/','_', $r['name']);
                    $zip->addFromString($entry, $r['data']);
                    $totalFiles++;
                }
            }
            $zip->close();
        } catch (Throwable $e) {
            @$zip->close(); @unlink($tmpZip);
            echo json_encode(['ok'=>false,'error'=>$e->getMessage()]); break;
        }
        if ($totalFiles === 0) {
            @unlink($tmpZip);
            echo json_encode(['ok'=>false,'error'=>'Nenhum arquivo encontrado para os IDs informados.', 'details'=>$errors]); break;
        }
        // Faz streaming do ZIP montado para o cliente e o remove em seguida.
        $size = filesize($tmpZip);
        $fname = 'casos_'.date('Ymd_His').'_'.count($ids).'.zip';
        header_remove('Content-Type');
        header_remove('X-Frame-Options');
        header('Content-Type: application/zip');
        header('Content-Length: '.$size);
        header('Content-Disposition: attachment; filename="'.$fname.'"');
        header('Cache-Control: private, no-cache');
        readfile($tmpZip);
        @unlink($tmpZip);
        DB::log($me, 'sistema', 'download_bulk', null, ['ids'=>$ids,'files'=>$totalFiles,'errors'=>count($errors)]);
        exit;

    default:
        http_response_code(400);
        echo json_encode(['ok'=>false,'error'=>'Ação desconhecida.']);
}
