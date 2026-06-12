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

/*
 * Crashes nunca podem virar uma página HTML 500 muda: exceções não capturadas
 * e erros fatais são convertidos em JSON com tipo, arquivo e linha, para que
 * o frontend e o modo diagnóstico exibam a causa real em vez de um erro
 * genérico de conexão.
 */
set_exception_handler(function (Throwable $e) {
    if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
    echo json_encode([
        'ok'           => false,
        'error'        => $e->getMessage(),
        'error_tipo'   => get_class($e),
        'error_origem' => basename($e->getFile()).':'.$e->getLine(),
    ]);
});
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        if (!headers_sent()) { http_response_code(500); header('Content-Type: application/json; charset=utf-8'); }
        echo json_encode([
            'ok'           => false,
            'error'        => $e['message'],
            'error_tipo'   => 'FatalError',
            'error_origem' => basename($e['file']).':'.$e['line'],
        ]);
    }
});

require_once __DIR__ . '/../../private-config/config.php';
require_once __DIR__ . '/../../private-config/lib/db.php';
require_once __DIR__ . '/../../private-config/lib/google.php';

/* Build do backend. Atualize a cada deploy do handler.php; é exibido no painel
   "Diagnóstico de versão" do Admin Mode para confirmar que o PHP novo subiu. */
if (!defined('HANDLER_BUILD')) define('HANDLER_BUILD', 'v23.05 (2026-06-12)');

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

/*
 * Token CSRF por sessão. Emitido ao frontend no login e no check_session,
 * reenviado pelo cliente no cabeçalho X-CSRF-Token em toda requisição POST
 * autenticada e conferido com hash_equals antes do dispatch das ações.
 */
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));

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
    $base = null;
    $usersPath = PRIVATE_CONFIG_PATH.'/users_override.json';
    if (file_exists($usersPath)) {
        $usersOvr = json_decode(file_get_contents($usersPath), true) ?? [];
        if (isset($usersOvr[$user])) $base = $usersOvr[$user];
    }
    if ($base === null) {
        if (!isset(USERS[$user])) return null;
        $u = USERS[$user];
        $base = is_array($u) ? $u : ['hash' => $u, 'role' => 'user'];
    }
    // A sobrescrita de senha (troca pelo painel) aplica-se a qualquer usuário,
    // estático ou dinâmico, e tem precedência sobre o hash de origem. Resolver
    // o override aqui — em vez de retornar cedo para usuários dinâmicos —
    // garante que a senha nova entre em vigor no login.
    $overridePath = PRIVATE_CONFIG_PATH.'/passwords.json';
    if (file_exists($overridePath)) {
        $overrides = json_decode(file_get_contents($overridePath), true) ?? [];
        if (isset($overrides[$user]) && is_array($base)) $base['hash'] = $overrides[$user];
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

/**
 * Normaliza um nome de cidade para casamento contra o CSV de coordenadas:
 * uppercase e sem acentos. Byte-clean, não depende de extensões opcionais.
 */
function normalizeCidade(string $s): string {
    $s = trim(mb_strtoupper($s, 'UTF-8'));
    $from = ['Á','À','Ã','Â','Ä','É','È','Ê','Ë','Í','Ì','Î','Ï','Ó','Ò','Ô','Õ','Ö','Ú','Ù','Û','Ü','Ç','Ñ'];
    $to   = ['A','A','A','A','A','E','E','E','E','I','I','I','I','O','O','O','O','O','U','U','U','U','C','N'];
    return str_replace($from, $to, $s);
}

/**
 * Carrega o CSV `cidades_coords.csv` (IBGE) em memória com 3 índices:
 *   _uf_name → "UF|NORM" => entry (lookup direto)
 *   _by_name → NORM       => [entries] (busca por nome, sem saber UF)
 *   _norms   → array de NORMs únicos (varredura para fuzzy match)
 *
 * Em caso de falha retorna `['_error' => msg]` — o chamador deve abortar a
 * operação e mostrar a mensagem ao usuário.
 */
function loadCidadesCoords(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $path = PRIVATE_CONFIG_PATH . '/cidades_coords.csv';
    if (!file_exists($path)) { $cache = ['_error'=>'cidades_coords.csv não encontrado em private-config/']; return $cache; }
    $UF_MAP = [
        '12'=>'AC','27'=>'AL','16'=>'AP','13'=>'AM','29'=>'BA','23'=>'CE','53'=>'DF',
        '32'=>'ES','52'=>'GO','21'=>'MA','51'=>'MT','50'=>'MS','31'=>'MG','15'=>'PA',
        '25'=>'PB','41'=>'PR','26'=>'PE','22'=>'PI','33'=>'RJ','24'=>'RN','43'=>'RS',
        '11'=>'RO','14'=>'RR','42'=>'SC','35'=>'SP','28'=>'SE','17'=>'TO',
    ];
    $fh = @fopen($path, 'r');
    if (!$fh) { $cache = ['_error'=>'Não foi possível abrir cidades_coords.csv.']; return $cache; }
    $header = fgetcsv($fh);
    if (!$header) { fclose($fh); $cache = ['_error'=>'cidades_coords.csv: header inválido.']; return $cache; }
    $byUfName = []; $byName = [];
    while (($row = fgetcsv($fh)) !== false) {
        if (count($row) < 6) continue;
        $name = $row[1] ?? '';
        $lat  = (float)($row[2] ?? 0);
        $lng  = (float)($row[3] ?? 0);
        $uf   = $UF_MAP[$row[5] ?? ''] ?? null;
        if (!$uf || !$lat || !$lng) continue;
        $norm = normalizeCidade($name);
        $entry = ['lat'=>$lat, 'lng'=>$lng, 'name'=>$name, 'uf'=>$uf];
        $byUfName[$uf . '|' . $norm] = $entry;
        if (!isset($byName[$norm])) $byName[$norm] = [];
        $byName[$norm][] = $entry;
    }
    fclose($fh);
    if (empty($byUfName)) { $cache = ['_error'=>'cidades_coords.csv: nenhuma linha válida.']; return $cache; }
    $cache = ['_uf_name'=>$byUfName, '_by_name'=>$byName, '_norms'=>array_keys($byName)];
    return $cache;
}

/** Lookup direto por UF+cidade. Retorna ['lat','lng','name','uf'] ou null. */
function findCidadeCoords(string $uf, string $cidade): ?array {
    $coords = loadCidadesCoords();
    if (isset($coords['_error'])) return null;
    $key = strtoupper(trim($uf)) . '|' . normalizeCidade($cidade);
    return $coords['_uf_name'][$key] ?? null;
}

/** Lista todas as ocorrências de um nome normalizado (pode aparecer em várias UFs). */
function findCidadeAnywhere(string $cidadeNorm): array {
    $coords = loadCidadesCoords();
    if (isset($coords['_error'])) return [];
    return $coords['_by_name'][$cidadeNorm] ?? [];
}

/** Sugestões fuzzy por Levenshtein (usado no audit pra propor correções). */
function suggestSimilarCidades(string $cidadeNorm, int $maxDist = 3, int $maxResults = 3): array {
    $coords = loadCidadesCoords();
    if (isset($coords['_error'])) return [];
    $scored = [];
    $len = strlen($cidadeNorm);
    foreach ($coords['_norms'] as $norm) {
        if (abs(strlen($norm) - $len) > $maxDist) continue;
        $d = levenshtein($cidadeNorm, $norm);
        if ($d <= $maxDist) {
            foreach ($coords['_by_name'][$norm] as $entry) {
                $scored[] = ['name'=>$entry['name'], 'uf'=>$entry['uf'], 'distance'=>$d];
            }
        }
    }
    usort($scored, fn($a, $b) => $a['distance'] - $b['distance']);
    return array_slice($scored, 0, $maxResults);
}

/**
 * Tenta achar a UF da cidade testando cada UF candidata. Útil para cidades
 * já gravadas no caso, cuja UF não está mais alinhada por índice depois do
 * fix da v21.1 (dedup de UF na escrita).
 */
function findCidadeCoordsAmongUfs(string $cidade, array $candidateUfs): ?array {
    foreach ($candidateUfs as $uf) {
        $c = findCidadeCoords($uf, $cidade);
        if ($c) return $c;
    }
    return null;
}

/** Distância em km entre dois pontos (lat/lng), fórmula Haversine. */
function haversineKm(float $lat1, float $lng1, float $lat2, float $lng2): float {
    $R = 6371.0;
    $dLat = deg2rad($lat2 - $lat1);
    $dLng = deg2rad($lng2 - $lng1);
    $a = sin($dLat/2) ** 2
       + cos(deg2rad($lat1)) * cos(deg2rad($lat2)) * sin($dLng/2) ** 2;
    return $R * 2 * asin(sqrt($a));
}

/**
 * Carrega o mapa de "cidades coringa" de `distance_overrides.json` — cidades
 * muito populosas onde o raio mínimo é menor que o padrão global. O arquivo é
 * um objeto { "UF|CIDADE_NORMALIZADA": raio_km }. Cacheado por requisição.
 */
function loadDistanceOverrides(): array {
    static $cache = null;
    if ($cache !== null) return $cache;
    $path = PRIVATE_CONFIG_PATH . '/distance_overrides.json';
    if (!file_exists($path)) { $cache = []; return $cache; }
    $data = json_decode(file_get_contents($path), true);
    $cache = is_array($data) ? $data : [];
    return $cache;
}

/**
 * Raio mínimo (km) aplicável a uma cidade: o valor coringa, se a cidade estiver
 * cadastrada em `distance_overrides.json`, senão o padrão `DISTANCE_RADIUS_KM`.
 */
function cidadeRadiusKm(string $uf, string $cidade): float {
    $default = defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80;
    $key = strtoupper(trim($uf)) . '|' . normalizeCidade($cidade);
    $ovr = loadDistanceOverrides();
    if (isset($ovr[$key]) && is_numeric($ovr[$key]) && $ovr[$key] > 0) {
        return (float)$ovr[$key];
    }
    return $default;
}

/**
 * Lista TODAS as cidades existentes no caso que estão dentro do raio mínimo
 * da nova cidade. O raio de cada par é o MENOR entre o raio da nova cidade e
 * o da cidade existente — assim uma cidade coringa (raio reduzido) "puxa" para
 * baixo qualquer par de que participe. Retorna:
 *   - array de conflitos [{cidade, uf, distancia_km, raio_km}] — se houver
 *   - [] — se a nova cidade não tem conflito
 * Lança Exception se o CSV não puder ser carregado.
 */
function findDistanceConflicts(string $novaUf, string $novaCidade, array $caso): array {
    $coords = loadCidadesCoords();
    if (isset($coords['_error'])) {
        throw new Exception('Validação geográfica indisponível: '.$coords['_error']);
    }
    $alvo = findCidadeCoords($novaUf, $novaCidade);
    if (!$alvo) {
        // Cidade nova não encontrada no CSV → não dá pra calcular. Não bloqueia
        // (cidade pode ser rara/recente); a regra do raio simplesmente não se aplica.
        return [];
    }
    $raioNova = cidadeRadiusKm($alvo['uf'], $alvo['name']);
    $candidateUfs = $caso['ufs'] ?? [];
    $conflitos = [];
    foreach (($caso['cidades'] ?? []) as $cid) {
        if (!$cid) continue;
        if (normalizeCidade($cid) === normalizeCidade($novaCidade)) continue;
        $ex = findCidadeCoordsAmongUfs($cid, $candidateUfs);
        if (!$ex) continue;
        $d = haversineKm($alvo['lat'], $alvo['lng'], $ex['lat'], $ex['lng']);
        $raio = min($raioNova, cidadeRadiusKm($ex['uf'], $ex['name']));
        if ($d <= $raio) {
            $conflitos[] = ['cidade'=>$ex['name'], 'uf'=>$ex['uf'], 'distancia_km'=>round($d, 1), 'raio_km'=>$raio];
        }
    }
    return $conflitos;
}

/**
 * Lista canônica de tags definida pelo admin. Funciona como vocabulário
 * controlado: usuários só podem aplicar tags que existem aqui. Se o arquivo
 * não existe, retorna lista vazia (o endpoint `list_canonical_tags` faz a
 * migração inicial coletando as tags existentes nos casos).
 */
function loadCanonicalTags(): array {
    $path = PRIVATE_CONFIG_PATH.'/tags.json';
    if (!file_exists($path)) return [];
    $data = json_decode(file_get_contents($path), true);
    if (!is_array($data)) return [];
    return array_values(array_filter($data, fn($t) => is_string($t) && $t !== ''));
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
                'csrf'         => $_SESSION['csrf'],
            ]);
        }
    } else {
        echo json_encode(['ok'=>false,'authenticated'=>false]);
    }
    exit;
}

/**
 * Valida um token do Cloudflare Turnstile contra o endpoint siteverify.
 * Retorna true apenas quando o Cloudflare confirma `success`.
 */
function verifyTurnstile(string $token, string $ip): bool {
    $resp = hpost(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        http_build_query(['secret'=>TURNSTILE_SECRET, 'response'=>$token, 'remoteip'=>$ip]),
        ['Content-Type: application/x-www-form-urlencoded']
    );
    if (!$resp) return false;
    $d = json_decode($resp, true);
    return !empty($d['success']);
}

/*
 * Endpoint `login` — autentica usuário e estabelece a sessão.
 * Aplica rate limiting por IP e regenera o session id na autenticação
 * bem-sucedida para prevenir session fixation.
 */
if ($action === 'login') {
    $user = trim($_POST['user'] ?? '');
    $pass = $_POST['pass'] ?? '';

    // Cloudflare Turnstile: só exige verificação quando a secret está configurada.
    if (TURNSTILE_SECRET !== '') {
        $tsToken = $_POST['cf-turnstile-response'] ?? '';
        if ($tsToken === '' || !verifyTurnstile($tsToken, $ip)) {
            http_response_code(403);
            echo json_encode(['ok'=>false,'error'=>'Verificação de segurança falhou. Recarregue a página e tente novamente.']);
            exit;
        }
    }

    /*
     * Chave de bloqueio por (usuário + dispositivo) em vez de IP único.
     *
     * Motivação: a empresa toda usa o mesmo WiFi, então o IP público é
     * compartilhado. Bloquear por IP fazia uma pessoa errar a senha 5x
     * e impedir todo mundo de acessar. Agora cada navegador carrega um
     * cookie persistente `bi_device` e o limite é aplicado à dupla
     * (usuário tentado, dispositivo). Sem cookie (primeiro acesso),
     * cai num modo de IP para não deixar o sistema desprotegido.
     */
    $deviceId = $_COOKIE['bi_device'] ?? '';
    $blockKey = $deviceId !== ''
        ? 'u:'.$user.':d:'.substr($deviceId, 0, 32)
        : 'u:'.$user.':i:'.$ip;

    try {
        if (DB::isBlocked($blockKey)) {
            $min = DB::blockRemaining($blockKey);
            http_response_code(429);
            echo json_encode(['ok'=>false,'error'=>"Acesso bloqueado temporariamente por {$min} min após várias tentativas. Aguarde ou tente em outro dispositivo."]);
            exit;
        }
    } catch (Throwable $e) {}

    $uData = getUserData($user);
    if ($uData && password_verify($pass, $uData['hash'])) {
        try { DB::clearFails($blockKey); } catch (Throwable $e) {}

        // Emite o cookie de dispositivo no primeiro login bem-sucedido.
        // 2 anos é suficiente para manter o reconhecimento sem precisar
        // armazenar no servidor; o cookie é httponly para não vazar via JS.
        if ($deviceId === '') {
            $newId = bin2hex(random_bytes(16));
            setcookie('bi_device', $newId, [
                'expires'  => time() + 86400 * 365 * 2,
                'path'     => '/',
                'secure'   => isset($_SERVER['HTTPS']),
                'httponly' => true,
                'samesite' => 'Lax',
            ]);
        }

        session_regenerate_id(true);
        $_SESSION['user']       = $user;
        $_SESSION['login_time'] = time();
        // Registra o login bem-sucedido para o painel de usuários ("último login").
        // No login ainda não há base ativa, então grava na tabela da base padrão
        // (prefixo vazio); o painel lê desse mesmo lugar, de forma consistente.
        try { DB::setPrefix(''); DB::log($user, 'sistema', 'login_success', null, null); } catch (Throwable $e) {}
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
            'csrf'      => $_SESSION['csrf'],
        ]);
    } else {
        try { DB::recordFail($blockKey); } catch (Throwable $e) {}
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

// Conferência CSRF: toda ação POST autenticada precisa reenviar o token da
// sessão (cabeçalho X-CSRF-Token, ou campo _csrf como fallback). GET é leitura
// e fica isento. hash_equals evita timing attack na comparação.
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $sentToken = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? ($_POST['_csrf'] ?? '');
    if (!is_string($sentToken) || !hash_equals($_SESSION['csrf'] ?? '', $sentToken)) {
        http_response_code(419);
        echo json_encode(['ok'=>false,'error'=>'Token de segurança inválido ou expirado. Recarregue a página (F5) e tente novamente.']);
        exit;
    }
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
 * Lê-modifica-grava um arquivo JSON sob lock exclusivo de arquivo.
 *
 * O callback recebe o conteúdo atual decodificado (array; vazio se o arquivo
 * não existe) e deve retornar o novo conteúdo a ser gravado, ou null para
 * abortar a escrita. O lock impede que duas requisições concorrentes leiam
 * o mesmo estado e gravem por cima uma da outra (perda silenciosa).
 *
 * Uso típico: alteração de passwords.json, users_override.json,
 * production_users.json em chamadas administrativas paralelas.
 */
function withJsonLock(string $jsonPath, callable $fn): void {
    $lockPath = $jsonPath . '.lock';
    $fp = @fopen($lockPath, 'c+');
    if (!$fp) {
        // Fallback best-effort caso o filesystem rejeite o lock: ainda é
        // melhor do que falhar a operação inteira.
        $data = file_exists($jsonPath) ? (json_decode(file_get_contents($jsonPath), true) ?? []) : [];
        $newData = $fn($data);
        if ($newData !== null) {
            file_put_contents($jsonPath, json_encode($newData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
        }
        return;
    }
    flock($fp, LOCK_EX);
    try {
        $data = file_exists($jsonPath) ? (json_decode(file_get_contents($jsonPath), true) ?? []) : [];
        $newData = $fn($data);
        if ($newData !== null) {
            file_put_contents($jsonPath, json_encode($newData, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE), LOCK_EX);
        }
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

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

/**
 * Optimistic locking: recusa a gravação se o caso mudou desde que o cliente o
 * carregou. Só valida quando o cliente envia `ver` (clientes antigos seguem sem
 * a checagem). Em divergência, emite a resposta de erro e retorna false para o
 * caller abortar com `break`.
 */
/** Compara duas listas por valor e ordem, normalizando a reindexação. */
function arrEq(array $a, array $b): bool {
    return array_values($a) === array_values($b);
}

function checkCaseVersion(array $caso): bool {
    $sent = $_POST['ver'] ?? '';
    if ($sent !== '' && isset($caso['ver']) && !hash_equals((string)$caso['ver'], (string)$sent)) {
        echo json_encode([
            'ok'    => false,
            'stale' => true,
            'error' => 'Este caso foi alterado por outra pessoa enquanto você o editava. Recarregue o caso e refaça a ação.',
        ]);
        return false;
    }
    return true;
}

function thumbUrl(?string $f): ?string {
    global $thumbDir, $thumbBaseUrl;
    if (!$f) return null;
    return file_exists($thumbDir.'/'.$f) ? $thumbBaseUrl.'/'.$f : null;
}
/* Rendição grande (~1600px) já materializada em disco pela action
   view_preview. Quando existe, o frontend a carrega como arquivo estático,
   sem passar pelo PHP. */
function previewUrl(?string $fileId): ?string {
    global $thumbDir, $thumbBaseUrl;
    if (!$fileId) return null;
    $f = $fileId.'_p.jpg';
    return file_exists($thumbDir.'/'.$f) ? $thumbBaseUrl.'/'.$f : null;
}
function enrichPhotos(array $photos): array {
    foreach ($photos as &$p) {
        $p['thumb_url']   = thumbUrl($p['local_thumb'] ?? null);
        $p['preview_url'] = previewUrl($p['id'] ?? null);
    }
    return $photos;
}

/**
 * Diagnóstico do cache de thumbnails de um caso (admin). Lê o registro bruto
 * da tabela — ignorando o TTL — e confere os arquivos físicos em disco, para
 * apontar em qual camada o cache está falhando: linha ausente no MySQL,
 * registro expirado (ou com idade negativa, indicando relógio dessincronizado)
 * ou arquivos sumidos do diretório de thumbs.
 */
function thumbCacheDiag(string $id): array {
    global $thumbDir;
    $d = [
        'ttl_config' => (int)THUMB_CACHE_TTL,
        'prefixo'    => DB::getPrefix(),
        'thumb_dir'  => $thumbDir,
        'dir_ok'     => is_dir($thumbDir) && is_writable($thumbDir),
    ];
    $livre = @disk_free_space(is_dir($thumbDir) ? $thumbDir : __DIR__);
    if ($livre !== false) $d['disco_livre_mb'] = (int)round($livre / 1048576);
    try {
        $st = DB::get()->prepare(
            "SELECT photos_json, updated_at, TIMESTAMPDIFF(SECOND, updated_at, NOW()) AS idade
             FROM ".DB::getPrefix()."thumb_cache WHERE caso_id=?"
        );
        $st->execute([$id]);
        $row = $st->fetch();
        if (!$row) { $d['registro'] = 'ausente'; return $d; }
        $d['registro']   = 'presente';
        $d['updated_at'] = $row['updated_at'];
        $d['idade_seg']  = (int)$row['idade'];
        $d['expirado']   = $d['idade_seg'] > (int)THUMB_CACHE_TTL || $d['idade_seg'] < 0;
        $fotos = json_decode($row['photos_json'], true);
        $d['fotos_no_registro'] = is_array($fotos) ? count($fotos) : null;
        $ok = 0; $semThumb = 0; $faltando = []; $motivos = [];
        foreach ((array)$fotos as $p) {
            if (!empty($p['thumb_error'])) $motivos[$p['thumb_error']] = true;
            if (empty($p['local_thumb'])) { $semThumb++; continue; }
            if (file_exists($thumbDir.'/'.$p['local_thumb'])) $ok++;
            else $faltando[] = $p['local_thumb'];
        }
        $d['arquivos_ok'] = $ok;
        $d['sem_thumb_no_registro'] = $semThumb;
        if ($faltando) $d['arquivos_faltando'] = array_slice($faltando, 0, 5);
        if ($motivos)  $d['motivos_download'] = array_slice(array_keys($motivos), 0, 3);
    } catch (Throwable $e) {
        $d['erro'] = $e->getMessage();
    }
    return $d;
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
        catch (Throwable $e) { $r['mysql'] = ['ok'=>false,'msg'=>'❌ ['.get_class($e).'] '.$e->getMessage()]; }

        // Confirma a existência e o funcionamento da tabela de auditoria.
        if ($r['mysql']['ok']) {
            try {
                $cnt = DB::get()->query("SELECT COUNT(*) FROM ".DB::getPrefix()."audit_log")->fetchColumn();
                $r['audit_log'] = ['ok'=>true,'msg'=>"✓ Tabela OK — {$cnt} registros"];
            } catch (Throwable $e) {
                $r['audit_log'] = ['ok'=>false,'msg'=>'❌ Tabela audit_log ['.get_class($e).']: '.$e->getMessage()];
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
        catch (Throwable $e) { $r['google_auth'] = ['ok'=>false,'msg'=>'❌ ['.get_class($e).'] '.$e->getMessage()]; }

        if ($r['google_auth']['ok'] ?? false) {
            try { $casos=$api->getCasos(); $r['sheets']=['ok'=>true,'msg'=>'✓ '.count($casos).' casos']; }
            catch (Throwable $e) { $r['sheets']=['ok'=>false,'msg'=>'❌ ['.get_class($e).'] '.$e->getMessage()]; }
            try {
                $ids   = $api->getAllFolderIds();
                $files = $api->listDriveFolder(5);
                $r['drive'] = ['ok'=>true,'msg'=>'✓ '.count($ids).' pasta(s). Primeiros: '.implode(', ',array_column($files,'name'))];
            } catch (Throwable $e) { $r['drive']=['ok'=>false,'msg'=>'❌ ['.get_class($e).'] '.$e->getMessage()]; }
        } else {
            $r['sheets'] = $r['drive'] = ['ok'=>false,'msg'=>'Não testado'];
        }

        try {
            $tc = DB::get()->query("SELECT COUNT(*) FROM ".DB::getPrefix()."thumb_cache")->fetchColumn();
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
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
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
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
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
                if (!$cached) {
                    $resp = ['ok'=>false,'error'=>'Não há cache para este caso.','photos'=>[]];
                    if ($isAdmin) $resp['diag'] = thumbCacheDiag($id);
                    echo json_encode($resp); break;
                }
                $resp = ['ok'=>true,'photos'=>enrichPhotos($cached),'source'=>'cache'];
                if ($isAdmin) $resp['diag'] = thumbCacheDiag($id);
                echo json_encode($resp);
            } else {
                $photos = enrichPhotos($api->getDrivePhotos($id, $force));
                $src = ($force && $source==='drive') ? 'drive' : (DB::getThumbCache($id)!==null ? 'cache' : 'drive');
                $resp = ['ok'=>true,'photos'=>$photos,'source'=>$src];
                if ($isAdmin) $resp['diag'] = thumbCacheDiag($id);
                echo json_encode($resp);
            }
        } catch (Throwable $e) {
            $resp = ['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine(),'photos'=>[]];
            if ($isAdmin) { try { $resp['diag'] = thumbCacheDiag($id); } catch (Throwable $e2) {} }
            echo json_encode($resp);
        }
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
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // ── Novos arquivos ────────────────────────────────────
    case 'new_files':
        try { $f=$api->getDriveNewFiles(7); echo json_encode(['ok'=>true,'files'=>$f,'count'=>count($f)]); }
        catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine(),'count'=>0]); }
        break;

    // ── Histórico ─────────────────────────────────────────
    case 'historico':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_GET['caso_id']??''));
        $usuario = preg_replace('/[^a-zA-Z0-9_]/','',$_GET['usuario']??'');
        // Limite "quase infinito" — o teto de 100k existe só para impedir
        // que um cliente malicioso peça `limit=999999999` e force o servidor
        // a alocar memória demais. Para qualquer uso prático isso é suficiente.
        $limit   = min(100000, max(10, (int)($_GET['limit']??200)));
        try {
            // Eventos de login (login_success) não são "alterações de caso";
            // ficam de fora do histórico de mudanças (são exibidos no painel de
            // usuários como "último login").
            $log = DB::getLog($limit, $caso_id, $usuario, ['login_success']);
            foreach ($log as &$e) {
                if (!empty($e['antes_json']))  $e['antes']  = json_decode($e['antes_json'],  true);
                if (!empty($e['depois_json'])) $e['depois'] = json_decode($e['depois_json'], true);
                unset($e['antes_json'], $e['depois_json']);
            }
            echo json_encode(['ok'=>true,'log'=>$log,'count'=>count($log)]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine(),'log'=>[]]); }
        break;

    // ── Lista de cidades por UF (substitui a chamada direta ao IBGE) ──────
    // Lê o CSV de coordenadas já existente no servidor. Vantagem: funciona sem
    // internet/atrás de firewall e fica alinhado com a validação de distância
    // (que também depende desse CSV). Liberado a qualquer usuário logado.
    case 'list_cities':
        $uf = strtoupper(trim($_GET['uf'] ?? ''));
        if (!preg_match('/^[A-Z]{2}$/', $uf)) { echo json_encode(['ok'=>false,'error'=>'UF inválida.','cities'=>[]]); break; }
        $coords = loadCidadesCoords();
        if (isset($coords['_error'])) { echo json_encode(['ok'=>false,'error'=>$coords['_error'],'cities'=>[]]); break; }
        $cities = [];
        foreach ($coords['_uf_name'] as $key => $entry) {
            if (strpos($key, $uf.'|') === 0) $cities[] = mb_strtoupper($entry['name'], 'UTF-8');
        }
        $cities = array_values(array_unique($cities));
        sort($cities);
        echo json_encode(['ok'=>true,'uf'=>$uf,'cities'=>$cities,'count'=>count($cities)]);
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

            // Verificação geográfica: cidades em uso dentro de DISTANCE_RADIUS_KM.
            // Usuário comum é SEMPRE bloqueado (force não bypassa). Admin recebe
            // warning e confirma com force=1 pra prosseguir.
            try {
                $conflitos = findDistanceConflicts($nova_uf, $nova_cid, $caso);
            } catch (Throwable $e) {
                echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine().' Não foi possível validar a distância — tente novamente mais tarde ou contate o administrador.']); break;
            }
            if (!empty($conflitos)) {
                $lista = array_map(fn($c) => "{$c['cidade']}/{$c['uf']} ({$c['distancia_km']}km, limite {$c['raio_km']}km)", $conflitos);
                $msg = "Cidades em uso perto demais de ".ucwords(strtolower($nova_cid)).": ".implode(', ', $lista).".";
                if (!$isAdmin) {
                    echo json_encode(['ok'=>false,'error'=>"{$msg} Apenas administradores podem prosseguir — contate um admin."]);
                    break;
                }
                if (!$force) {
                    echo json_encode(['ok'=>false,'warn'=>true,'msg'=>"⚠️ {$msg} Continuar mesmo assim?"]);
                    break;
                }
            }

            // Estado duplicado dispara warning. Após o fix da v21.1, a UF não é
            // duplicada na escrita (array ufs vira um conjunto único). Por isso o
            // alinhamento por índice entre ufs e cidades/clientes deixa de ser
            // garantido; a mensagem fica genérica em vez de listar quem está em
            // cada cidade — os detalhes ficam no painel do caso.
            if (!$force && in_array($nova_uf, $caso['ufs'])) {
                echo json_encode(['ok'=>false,'warn'=>true,'msg'=>
                    "ATENÇÃO: {$caso_id} já tem uso registrado no estado {$nova_uf}. Confira no painel. Deseja continuar mesmo assim?"
                ]);
                break;
            }

            $antes  = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            // UF só é acrescentada quando ainda não existe — a coluna C do Sheets
            // passa a guardar um conjunto único. Cidade e cliente entram normalmente.
            $nufs   = in_array($nova_uf, $caso['ufs'], true)
                ? array_values($caso['ufs'])
                : array_merge($caso['ufs'], [$nova_uf]);
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
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    /*
     * Add em lote: aceita múltiplas tuplas (UF, cidade, prof) e grava todas
     * de forma ATÔMICA. Pré-flight valida tudo antes de tocar no Sheets — se
     * uma linha falha, nenhuma é gravada.
     *
     * Payload POST:
     *   caso_id, row, force ('1' opcional pra bypass de warnings)
     *   entries: JSON [{uf, cidade, profissional}, ...]
     */
    case 'add_uso_batch':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $force   = !empty($_POST['force']);
        $entriesRaw = $_POST['entries'] ?? '[]';
        $entries = json_decode($entriesRaw, true);

        if (!$caso_id || !$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        if (!is_array($entries) || empty($entries)) {
            echo json_encode(['ok'=>false,'error'=>'Informe ao menos uma linha.']); break;
        }
        if (count($entries) > 30) {
            echo json_encode(['ok'=>false,'error'=>'Máximo de 30 linhas por batch.']); break;
        }

        // Normaliza cada entrada.
        $clean = [];
        foreach ($entries as $i => $e) {
            $uf  = strtoupper(trim($e['uf'] ?? ''));
            $cid = strtoupper(trim($e['cidade'] ?? ''));
            $prof= trim($e['profissional'] ?? '');
            if ($uf === '' || $cid === '' || $prof === '') {
                echo json_encode(['ok'=>false,'error'=>'Linha '.($i+1).' incompleta.']); break 2;
            }
            $clean[] = ['uf'=>$uf, 'cidade'=>$cid, 'profissional'=>$prof];
        }

        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']);
                break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!checkCaseVersion($caso)) break;
            if (!empty($caso['bloqueado'])) {
                $motivo = trim($caso['motivo_bloqueio'] ?? '');
                echo json_encode(['ok'=>false,'error'=>'Caso BLOQUEADO — não pode receber novos usos.'.($motivo!==''?' Motivo: '.$motivo:'')]);
                break;
            }

            // Pre-flight: coleta TODOS os erros (não para no primeiro) pra dar
            // ao usuário uma visão completa do que está errado.
            $errs = [];
            $warns = [];
            $seenCid  = [];
            $seenPair = [];
            foreach ($clean as $i => $e) {
                $tag = 'Linha '.($i+1);
                // Duplicata interna no batch (mesma cidade).
                if (isset($seenCid[$e['cidade']])) {
                    $errs[] = "{$tag}: cidade ".ucwords(strtolower($e['cidade']))." aparece em duas linhas do batch.";
                }
                $seenCid[$e['cidade']] = $i;
                // Duplicata interna no batch (mesma cidade+prof).
                $pairKey = $e['cidade'].'|'.mb_strtoupper($e['profissional'],'UTF-8');
                if (isset($seenPair[$pairKey])) {
                    $errs[] = "{$tag}: mesmo profissional+cidade em duas linhas do batch.";
                }
                $seenPair[$pairKey] = $i;
                // Cidade já em uso no caso (hard-block).
                if (in_array($e['cidade'], $caso['cidades'], true)) {
                    $errs[] = "{$tag}: cidade ".ucwords(strtolower($e['cidade']))." já está em uso neste caso.";
                }
                // UF já no caso → warning (não bloqueia, só pede confirmação).
                if (!$force && in_array($e['uf'], $caso['ufs'], true)) {
                    $warns[] = "{$tag}: estado {$e['uf']} já tem uso registrado neste caso.";
                }
            }

            if (count($errs) > 0) {
                echo json_encode(['ok'=>false,'error'=>'Não foi possível registrar:','errors'=>$errs]);
                break;
            }

            // Verificação geográfica de cada linha. Considera cidades já no caso
            // E as cidades de linhas anteriores do mesmo batch. Usuário comum é
            // SEMPRE bloqueado (force não bypassa); admin recebe warn e confirma.
            try {
                $simulated = ['ufs'=>$caso['ufs'], 'cidades'=>$caso['cidades']];
                $distErrs = [];
                $distWarns = [];
                foreach ($clean as $i => $e) {
                    $conf = findDistanceConflicts($e['uf'], $e['cidade'], $simulated);
                    if (!empty($conf)) {
                        $lista = array_map(fn($c) => "{$c['cidade']}/{$c['uf']} ({$c['distancia_km']}km, limite {$c['raio_km']}km)", $conf);
                        $line = "Linha ".($i+1).": cidades em uso perto demais de ".ucwords(strtolower($e['cidade'])).": ".implode(', ', $lista).".";
                        if (!$isAdmin) $distErrs[] = $line;
                        else           $distWarns[] = $line;
                    }
                    if (!in_array($e['uf'], $simulated['ufs'], true)) $simulated['ufs'][] = $e['uf'];
                    $simulated['cidades'][] = $e['cidade'];
                }
            } catch (Throwable $e) {
                echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine().' Não foi possível validar a distância — tente novamente mais tarde.']); break;
            }
            if (!empty($distErrs)) {
                echo json_encode(['ok'=>false,'error'=>'Bloqueado por distância — apenas admins podem prosseguir:','errors'=>$distErrs]);
                break;
            }
            if (!$force && (!empty($warns) || !empty($distWarns))) {
                $allWarns = array_merge($warns, $distWarns);
                echo json_encode(['ok'=>false,'warn'=>true,
                    'msg'=>"ATENÇÃO: ".implode(' ', $allWarns)." Deseja continuar mesmo assim?",
                    'warns'=>$allWarns]);
                break;
            }

            // Tudo OK — monta novos arrays e grava UMA vez.
            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $nufs  = $caso['ufs'];
            $ncids = $caso['cidades'];
            $nclis = $caso['clientes'];
            foreach ($clean as $e) {
                if (!in_array($e['uf'], $nufs, true)) $nufs[] = $e['uf'];
                $ncids[] = $e['cidade'];
                $nclis[] = $e['profissional'];
            }
            $api->updateCaso($row, implode('/',$nufs), implode('/',$ncids), implode('/',$nclis));
            DB::log($me, $caso_id, 'add_uso_batch', $antes, [
                'ufs'=>$nufs, 'cidades'=>$ncids, 'clientes'=>$nclis,
                'count'=>count($clean), 'entries'=>$clean,
            ]);

            $newVer = GoogleAPI::caseVersion($nufs, $ncids, $nclis, $caso['tags']??[], $caso['motivo_bloqueio']??'');
            echo json_encode([
                'ok'=>true,
                'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis],
                'count'=>count($clean),
                'ver'=>$newVer,
            ]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    /*
     * Pré-flight do registro em massa: valida o trio (uf, cidade, prof) contra
     * TODOS os casos selecionados. Devolve `errors` (bloqueios) e `warns` (admin
     * pode prosseguir). O frontend usa pra implementar atomicidade — só dispara
     * os writes se errors estiver vazio.
     */
    case 'bulk_preflight':
        $idsRaw   = $_POST['ids'] ?? '';
        $nova_uf  = strtoupper(trim($_POST['uf'] ?? ''));
        $nova_cid = strtoupper(trim($_POST['cidade'] ?? ''));
        $prof     = trim($_POST['profissional'] ?? '');
        $ids = array_values(array_filter(
            array_map('trim', explode(',', $idsRaw)),
            fn($x) => preg_match('/^CASO-\d+$/', $x)
        ));
        if (!$ids || !$nova_uf || !$nova_cid || !$prof) {
            echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break;
        }
        try {
            $errs = [];
            $warns = [];
            $casosAll = $api->getCasos(false);
            foreach ($ids as $cid) {
                $caso = null;
                foreach ($casosAll as $c) if ($c['id'] === $cid) { $caso = $c; break; }
                if (!$caso) { $errs[] = "{$cid}: não encontrado"; continue; }
                if (!empty($caso['bloqueado'])) { $errs[] = "{$cid}: caso bloqueado"; continue; }
                if (in_array($nova_cid, $caso['cidades'], true)) {
                    $errs[] = "{$cid}: cidade ".ucwords(strtolower($nova_cid))." já está em uso";
                    continue;
                }
                try {
                    $conf = findDistanceConflicts($nova_uf, $nova_cid, $caso);
                } catch (Throwable $e) {
                    echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); break 2;
                }
                if (!empty($conf)) {
                    $lista = array_map(fn($x) => "{$x['cidade']}/{$x['uf']} ({$x['distancia_km']}km, limite {$x['raio_km']}km)", $conf);
                    $line = "{$cid}: cidades perto demais — ".implode(', ', $lista);
                    if (!$isAdmin) $errs[] = $line;
                    else           $warns[] = $line;
                }
                if (in_array($nova_uf, $caso['ufs'], true)) {
                    $warns[] = "{$cid}: estado {$nova_uf} já tem uso";
                }
            }
            echo json_encode(['ok'=>true, 'errors'=>$errs, 'warns'=>$warns]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    // ── Remove uso ────────────────────────────────────────
    case 'remove_uso':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $idx     = (int)($_POST['idx']??-1);

        if (!$caso_id||!$row||$idx<0) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']); break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!checkCaseVersion($caso)) break;
            if (!isset($caso['ufs'][$idx])) { echo json_encode(['ok'=>false,'error'=>'Índice inválido.']); break; }

            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes']];
            $ufs=$caso['ufs']; $cids=$caso['cidades']; $clis=$caso['clientes'];
            array_splice($ufs,$idx,1); array_splice($cids,$idx,1); array_splice($clis,$idx,1);

            $api->updateCaso($row, implode('/',$ufs), implode('/',$cids), implode('/',$clis));
            DB::log($me, $caso_id, 'remove_uso', $antes, ['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis]);

            $newVer = GoogleAPI::caseVersion($ufs, $cids, $clis, $caso['tags']??[], $caso['motivo_bloqueio']??'');
            echo json_encode(['ok'=>true,'depois'=>['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis],'ver'=>$newVer]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
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
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']); break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!checkCaseVersion($caso)) break;

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

            $newVer = GoogleAPI::caseVersion($ufs, $cids, $clis, $caso['tags']??[], $caso['motivo_bloqueio']??'');
            echo json_encode(['ok'=>true,'depois'=>['ufs'=>$ufs,'cidades'=>$cids,'clientes'=>$clis],'ver'=>$newVer]);
        } catch (Throwable $e) {
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    // Presença em edição: registra/atualiza/remove a presença do usuário num
    // caso e devolve os OUTROS usuários ativos (heartbeat < 45s). Base para o
    // aviso "fulano também está editando este caso".
    case 'case_presence':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $event   = $_POST['event'] ?? 'ping';   // open | ping | close
        if (!$caso_id) { echo json_encode(['ok'=>false,'error'=>'Caso inválido.']); break; }
        $others = [];
        withJsonLock(PRIVATE_CONFIG_PATH.'/presence.json', function($data) use ($caso_id, $event, $me, &$others) {
            if (!is_array($data)) $data = [];
            $now = time();
            // Poda entradas antigas (>45s) em todos os casos para não acumular.
            foreach ($data as $cid => $users) {
                foreach ($users as $u => $ts) if (!is_int($ts) || ($now - $ts) > 45) unset($data[$cid][$u]);
                if (empty($data[$cid])) unset($data[$cid]);
            }
            if ($event === 'close') {
                unset($data[$caso_id][$me]);
                if (isset($data[$caso_id]) && empty($data[$caso_id])) unset($data[$caso_id]);
            } else {
                $data[$caso_id][$me] = $now;
            }
            foreach (($data[$caso_id] ?? []) as $u => $ts) if ($u !== $me) $others[] = $u;
            return $data;
        });
        echo json_encode(['ok'=>true,'others'=>array_values(array_unique($others))]);
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
                // Limpeza global afeta todos os usuários da base — restrita a admin.
                requireAdmin($isAdmin);
                DB::clearThumbCache();
                DB::clearFolderCache();
                DB::clearSheetCache();
                $deleted = 0;
                if (is_dir($thumbDir))
                    foreach (glob($thumbDir.'/*.{jpg,webp}', GLOB_BRACE) as $f) { @unlink($f); $deleted++; }
                echo json_encode(['ok'=>true,'msg'=>"Cache limpo. {$deleted} thumbs removidas."]);
            }
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Sincronização Drive↔planilha — PREVIEW. Cruza os IDs de caso encontrados
    // nos NOMES dos arquivos do Drive com as linhas da planilha. Compara por
    // número (ignora zeros à esquerda) pra não duplicar. Liberado a qualquer
    // usuário logado (ação de leitura).
    case 'sync_preview':
        try {
            $driveIds = $api->listDriveCaseIds();
            DB::clearSheetCache();
            $casos    = $api->getCasos(true);
            $numOf    = fn($id) => (int)preg_replace('/\D/', '', $id);
            $sheetNums = [];  foreach ($casos as $c)     $sheetNums[$numOf($c['id'])] = $c['id'];
            $driveNums = [];  foreach ($driveIds as $did) $driveNums[$numOf($did)]    = $did;
            $driveOnly = [];  foreach ($driveNums as $n => $did) if (!isset($sheetNums[$n])) $driveOnly[] = $did;
            $sheetOnly = [];  foreach ($sheetNums as $n => $sid) if (!isset($driveNums[$n])) $sheetOnly[] = $sid;
            sort($driveOnly); sort($sheetOnly);
            echo json_encode([
                'ok'          => true,
                'drive_only'  => $driveOnly,   // no Drive, faltando na planilha → criar linha
                'sheet_only'  => $sheetOnly,   // na planilha, sem arquivos → pendente de fotos
                'drive_total' => count($driveNums),
                'sheet_total' => count($sheetNums),
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Sincronização Drive↔planilha — APPLY. Cria linhas (só o ID na coluna B)
    // para os IDs informados que ainda não existem na planilha. Liberado a
    // qualquer usuário logado; é aditivo (só cria linhas de IDs já no Drive).
    case 'sync_apply':
        $ids = array_values(array_filter(array_map(
            fn($s) => preg_replace('/[^A-Z0-9\-]/', '', strtoupper(trim($s))),
            explode(',', $_POST['ids'] ?? '')
        )));
        if (empty($ids)) { echo json_encode(['ok'=>false,'error'=>'Nenhum ID informado.']); break; }
        try {
            DB::clearSheetCache();
            $casos    = $api->getCasos(true);
            $existing = [];
            foreach ($casos as $c) $existing[(int)preg_replace('/\D/', '', $c['id'])] = true;
            $created = []; $skipped = []; $errors = [];
            foreach ($ids as $id) {
                $n = (int)preg_replace('/\D/', '', $id);
                if (!$n)               { $errors[] = "{$id}: ID sem número"; continue; }
                if (isset($existing[$n])) { $skipped[] = $id; continue; }
                try {
                    $api->appendCaso($id);
                    DB::log($me, $id, 'sync_create_row', [], ['id'=>$id]);
                    $created[] = $id; $existing[$n] = true;
                } catch (Throwable $e) { $errors[] = "{$id}: ".$e->getMessage(); }
            }
            echo json_encode(['ok'=>true, 'created'=>$created, 'skipped'=>$skipped, 'errors'=>$errors]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Reverte um caso para um estado anterior identificado pelo histórico de auditoria (admin).
    case 'revert_caso':
        requireAdmin($isAdmin);
        $caso_id  = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row      = (int)($_POST['row']??0);
        // Flags indicam quais grupos de campos o estado-alvo contém. Uma entrada
        // de histórico pode ter mexido só em uso (C:E), só em tags (F) ou só no
        // motivo/bloqueio (G); restauramos apenas o que foi alterado, preservando
        // o restante do estado atual.
        $setUso    = ($_POST['set_uso']    ?? '') === '1';
        $setTags   = ($_POST['set_tags']   ?? '') === '1';
        $setMotivo = ($_POST['set_motivo'] ?? '') === '1';
        if (!$caso_id||!$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        if (!$setUso && !$setTags && !$setMotivo) { echo json_encode(['ok'=>false,'error'=>'Nada para reverter nesta entrada.']); break; }
        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']); break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true);
            $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado na planilha atual.']); break; }

            $splitArr = fn($s) => trim((string)$s) === '' ? [] : array_values(array_filter(array_map('trim', explode('/', (string)$s))));

            $antes = ['ufs'=>$caso['ufs'],'cidades'=>$caso['cidades'],'clientes'=>$caso['clientes'],'tags'=>$caso['tags']??[],'motivo_bloqueio'=>$caso['motivo_bloqueio']??''];

            $nufs   = $setUso    ? $splitArr($_POST['ufs']??'')      : $caso['ufs'];
            $ncids  = $setUso    ? $splitArr($_POST['cidades']??'')  : $caso['cidades'];
            $nclis  = $setUso    ? $splitArr($_POST['clientes']??'') : $caso['clientes'];
            $ntags  = $setTags   ? $splitArr($_POST['tags']??'')     : ($caso['tags']??[]);
            $nmot   = $setMotivo ? trim($_POST['motivo']??'')        : ($caso['motivo_bloqueio']??'');

            // Escrita atômica C:G restaura uso, tags e motivo/bloqueio de uma vez.
            $api->updateCaso($row, implode('/',$nufs), implode('/',$ncids), implode('/',$nclis), implode('/',$ntags), $nmot);

            // Verificação pós-gravação: relê a planilha e confere se o estado
            // bate com o alvo, devolvendo o resultado real ao cliente.
            DB::clearSheetCache();
            $after = null;
            foreach ($api->getCasos(true) as $c) { if ($c['id']===$caso_id) { $after=$c; break; } }
            $depois = $after
                ? ['ufs'=>$after['ufs'],'cidades'=>$after['cidades'],'clientes'=>$after['clientes'],'tags'=>$after['tags']??[],'motivo_bloqueio'=>$after['motivo_bloqueio']??'','bloqueado'=>$after['bloqueado']??false]
                : ['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'tags'=>$ntags,'motivo_bloqueio'=>$nmot];

            $verified = $after
                && arrEq($after['ufs'], $nufs)
                && arrEq($after['cidades'], $ncids)
                && arrEq($after['clientes'], $nclis)
                && arrEq($after['tags']??[], $ntags)
                && trim($after['motivo_bloqueio']??'') === trim($nmot);

            DB::log($me, $caso_id, 'revert', $antes, $depois);
            echo json_encode([
                'ok'       => true,
                'verified' => $verified,
                'depois'   => $depois,
                'ver'      => $after['ver'] ?? GoogleAPI::caseVersion($nufs,$ncids,$nclis,$ntags,$nmot),
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
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
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
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
                // login_success é gravado sempre na tabela da base padrão (prefixo
                // vazio = "audit_log"), pois no login ainda não há base ativa.
                // Por isso esta consulta usa a tabela sem prefixo, independente da
                // base que o admin esteja visualizando.
                $llSt = DB::get()->prepare("SELECT MAX(criado_em) as last FROM audit_log WHERE usuario=? AND acao='login_success'");
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
        withJsonLock(PRIVATE_CONFIG_PATH.'/production_users.json', function($map) use ($target, $allow) {
            if ($allow) $map[$target] = true; else unset($map[$target]);
            return $map;
        });
        DB::log($me, 'sistema', 'set_production_access', ['user'=>$target], ['prod_access'=>$allow]);
        echo json_encode(['ok'=>true,'msg'=>$allow?"'{$target}' agora tem acesso à produção.":"'{$target}' voltou ao modo teste."]);
        break;

    case 'change_password':
        requireAdmin($isAdmin);
        $target = trim($_POST['target_user']??'');
        $newpass = $_POST['new_password']??'';
        if (!$target) { echo json_encode(['ok'=>false,'error'=>'Usuário não especificado.']); break; }
        $targetData = getUserData($target);
        if (!$targetData) { echo json_encode(['ok'=>false,'error'=>'Usuário não encontrado.']); break; }
        // Salvaguarda: um admin não pode alterar a senha de outro admin.
        if (($targetData['role']??'user') === 'admin' && $target !== $me) {
            echo json_encode(['ok'=>false,'error'=>'Não é possível alterar a senha de outro administrador.']); break;
        }
        if (strlen($newpass) < 6) { echo json_encode(['ok'=>false,'error'=>'Senha muito curta.']); break; }
        $newHash = password_hash($newpass, PASSWORD_DEFAULT);
        // Grava o novo hash no arquivo onde o usuário está definido, de modo a
        // substituir por completo a senha anterior e manter uma única senha
        // vigente por usuário. Usuários dinâmicos vivem em users_override.json;
        // usuários de config.php usam passwords.json como camada de sobrescrita.
        $usersOvrPath  = PRIVATE_CONFIG_PATH.'/users_override.json';
        $passwordsPath = PRIVATE_CONFIG_PATH.'/passwords.json';
        $isDynamic = false;
        if (file_exists($usersOvrPath)) {
            $ovr = json_decode(file_get_contents($usersOvrPath), true) ?? [];
            $isDynamic = isset($ovr[$target]);
        }
        if ($isDynamic) {
            withJsonLock($usersOvrPath, function($users) use ($target, $newHash) {
                if (isset($users[$target]) && is_array($users[$target])) $users[$target]['hash'] = $newHash;
                return $users;
            });
            // Remove qualquer hash obsoleto em passwords.json (não se aplica a
            // usuários dinâmicos) para não deixar duas senhas registradas.
            withJsonLock($passwordsPath, function($overrides) use ($target) {
                if (!isset($overrides[$target])) return null;
                unset($overrides[$target]);
                return $overrides;
            });
        } else {
            withJsonLock($passwordsPath, function($overrides) use ($target, $newHash) {
                $overrides[$target] = $newHash;
                return $overrides;
            });
        }
        DB::log($me, 'sistema', 'change_password', ['user'=>$target], ['changed'=>true]);
        echo json_encode(['ok'=>true,'msg'=>"Senha de '{$target}' alterada."]);
        break;

    /*
     * Diagnóstico de versão (admin). Devolve, para cada arquivo de front-end e
     * da API no servidor, a data de modificação, o tamanho, um hash curto do
     * conteúdo e — para os JS — o identificador de build embutido. O painel do
     * Admin Mode compara isso com o que o navegador carregou para revelar
     * arquivos desatualizados ou versões presas em cache.
     */
    case 'version_info':
        requireAdmin($isAdmin);
        $pub = WEB_ROOT;
        $files = [
            'index.php',
            'assets/utils.js', 'assets/admin.js', 'assets/app.js', 'assets/auth.js',
            'assets/panel.js', 'assets/casos.js', 'assets/bulk.js', 'assets/theme.js',
            'assets/app.css', 'assets/theme.css',
            'api/handler.php',
        ];
        $describe = function(string $label, string $abs): array {
            if (!is_file($abs)) return ['file' => $label, 'exists' => false];
            $content = (string)@file_get_contents($abs);
            $build = '';
            if (preg_match('/(?:APP_BUILD|ADMIN_BUILD)\s*=\s*\'([^\']*)\'/', $content, $bm)) $build = $bm[1];
            return [
                'file'   => $label,
                'exists' => true,
                'mtime'  => date('Y-m-d H:i:s', filemtime($abs)),
                'size'   => filesize($abs),
                'sha1'   => substr(sha1($content), 0, 10),
                'build'  => $build,
            ];
        };
        $out = [];
        foreach ($files as $rel) $out[] = $describe($rel, $pub . '/' . $rel);
        // As bibliotecas privadas (fora do webroot) são deployadas por outro
        // caminho e podem ficar dessincronizadas do restante — também entram
        // na conferência de versão.
        foreach (['lib/google.php', 'lib/db.php', 'config.php'] as $rel) {
            $out[] = $describe('private-config/' . $rel, PRIVATE_CONFIG_PATH . '/' . $rel);
        }
        echo json_encode(['ok'=>true, 'handler_build'=>HANDLER_BUILD, 'files'=>$out]);
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
        // Verifica duplicidade DENTRO do lock para impedir que dois admins
        // criem o mesmo usuário simultaneamente; o sinalizador "duplicate"
        // sai do callback para devolver o erro correto ao cliente.
        $duplicate = false;
        withJsonLock($usersPath, function($usersOvr) use ($newUser, $newPass, $newRole, &$duplicate) {
            if (isset($usersOvr[$newUser])) { $duplicate = true; return null; }
            $usersOvr[$newUser] = ['hash'=>password_hash($newPass,PASSWORD_DEFAULT),'role'=>$newRole];
            return $usersOvr;
        });
        if ($duplicate) { echo json_encode(['ok'=>false,'error'=>'Usuário já existe.']); break; }
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
        withJsonLock(PRIVATE_CONFIG_PATH.'/users_override.json', function($usersOvr) use ($target) {
            unset($usersOvr[$target]);
            return $usersOvr;
        });
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
            if (!checkCaseVersion($caso)) break;
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
            $newVer = GoogleAPI::caseVersion($nufs, $ncids, $nclis, $caso['tags']??[], $motivo);
            echo json_encode([
                'ok'=>true,
                'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'tags'=>$caso['tags']??[],'motivo_bloqueio'=>$motivo,'bloqueado'=>true],
                'ver'=>$newVer
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
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
            if (!checkCaseVersion($caso)) break;
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
            $newVer = GoogleAPI::caseVersion($nufs, $ncids, $nclis, $caso['tags']??[], '');
            echo json_encode([
                'ok'=>true,
                'depois'=>['ufs'=>$nufs,'cidades'=>$ncids,'clientes'=>$nclis,'tags'=>$caso['tags']??[],'motivo_bloqueio'=>'','bloqueado'=>false],
                'ver'=>$newVer
            ]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Adiciona uma tag ao caso. Aceita letras (incluindo acentuadas), números,
    // espaço, &, + e -; máx. 30 caracteres. `mb_strtoupper` é essencial:
    // `strtoupper` é byte-oriented e não converte caracteres não-ASCII.
    case 'add_tag':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        $tag     = mb_strtoupper(trim($_POST['tag']??''), 'UTF-8');
        $tag = preg_replace('/[^\p{L}\p{N} \&\+\-]/u','',$tag);
        $tag = trim(preg_replace('/\s+/',' ',$tag));
        if (!$caso_id || !$row) { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        if ($tag === '' || mb_strlen($tag) > 30) { echo json_encode(['ok'=>false,'error'=>'Tag inválida (1–30 caracteres).']); break; }
        try {
            // Validação contra a lista canônica de tags definida pelo admin.
            $canonical = loadCanonicalTags();
            if (!in_array($tag, $canonical, true)) {
                echo json_encode(['ok'=>false,'error'=>"A tag '{$tag}' não está cadastrada na lista global. Peça a um administrador para adicioná-la em Admin Mode → Gerenciar tags."]);
                break;
            }
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']);
                break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!checkCaseVersion($caso)) break;
            $cur = $caso['tags'] ?? [];
            if (in_array($tag, $cur, true)) { echo json_encode(['ok'=>true,'tags'=>$cur,'msg'=>'Tag já existe.']); break; }
            if (count($cur) >= 20) { echo json_encode(['ok'=>false,'error'=>'Máximo de 20 tags por caso.']); break; }
            $nv = array_values(array_merge($cur, [$tag]));
            $api->updateCasoTags($row, implode('/', $nv));
            DB::log($me, $caso_id, 'add_tag', ['tags'=>$cur], ['tags'=>$nv]);
            $newVer = GoogleAPI::caseVersion($caso['ufs'], $caso['cidades'], $caso['clientes'], $nv, $caso['motivo_bloqueio']??'');
            echo json_encode(['ok'=>true,'tags'=>$nv,'ver'=>$newVer]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Aplica UMA tag a VÁRIOS casos numa única leitura da planilha. Otimização do
    // add_tag para operações em lote: o gargalo do add_tag chamado em loop era
    // reler a planilha inteira (getCasos(true)) a cada caso. Aqui lemos 1× e
    // gravamos as N linhas. Sem trava canônica (a UI sugere as tags cadastradas,
    // mas permite aplicar livremente em massa).
    case 'bulk_add_tag':
        $tag = mb_strtoupper(trim($_POST['tag'] ?? ''), 'UTF-8');
        $tag = preg_replace('/[^\p{L}\p{N} \&\+\-]/u', '', $tag);
        $tag = trim(preg_replace('/\s+/', ' ', $tag));
        $ids = array_values(array_filter(array_map(
            fn($s) => preg_replace('/[^A-Z0-9\-]/', '', strtoupper(trim($s))),
            explode(',', $_POST['ids'] ?? '')
        )));
        if (empty($ids))                         { echo json_encode(['ok'=>false,'error'=>'Nenhum caso informado.']); break; }
        if ($tag === '' || mb_strlen($tag) > 30) { echo json_encode(['ok'=>false,'error'=>'Tag inválida (1–30 caracteres).']); break; }
        try {
            // Leitura ÚNICA da planilha (não por caso).
            DB::clearSheetCache();
            $casos = $api->getCasos(true);
            $byId = [];
            foreach ($casos as $c) { $byId[$c['id']] = $c; }

            $applied = []; $skipped = []; $errors = [];
            foreach ($ids as $id) {
                $caso = $byId[$id] ?? null;
                if (!$caso)                     { $errors[] = "{$id}: não encontrado"; continue; }
                $cur = $caso['tags'] ?? [];
                if (in_array($tag, $cur, true)) { $skipped[] = $id; continue; }
                if (count($cur) >= 20)          { $errors[] = "{$id}: máximo de 20 tags"; continue; }
                $nv = array_values(array_merge($cur, [$tag]));
                try {
                    $api->updateCasoTags((int)$caso['row'], implode('/', $nv));
                    DB::log($me, $id, 'add_tag', ['tags'=>$cur], ['tags'=>$nv]);
                    $applied[] = $id;
                } catch (Throwable $e) { $errors[] = "{$id}: ".$e->getMessage(); }
            }
            echo json_encode(['ok'=>true, 'applied'=>$applied, 'skipped'=>$skipped, 'errors'=>$errors]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Remove uma tag do caso (idempotente: tag inexistente devolve a lista atual).
    case 'remove_tag':
        $caso_id = preg_replace('/[^A-Z0-9\-]/','',strtoupper($_POST['caso_id']??''));
        $row     = (int)($_POST['row']??0);
        // mb_strtoupper preserva o casing correto de caracteres acentuados.
        $tag     = mb_strtoupper(trim($_POST['tag']??''), 'UTF-8');
        if (!$caso_id || !$row || $tag === '') { echo json_encode(['ok'=>false,'error'=>'Dados inválidos.']); break; }
        try {
            if (!acquireCaseLock($caso_id)) {
                echo json_encode(['ok'=>false,'error'=>'Este caso está sendo editado por outro usuário. Tente novamente em alguns segundos.']);
                break;
            }
            DB::clearSheetCache();
            $casos = $api->getCasos(true); $caso = null;
            foreach ($casos as $c) { if ($c['id']===$caso_id) { $caso=$c; break; } }
            if (!$caso) { echo json_encode(['ok'=>false,'error'=>'Caso não encontrado.']); break; }
            if (!checkCaseVersion($caso)) break;
            $cur = $caso['tags'] ?? [];
            $nv  = array_values(array_filter($cur, fn($t)=>$t !== $tag));
            if (count($nv) === count($cur)) { echo json_encode(['ok'=>true,'tags'=>$cur,'msg'=>'Tag não estava presente.']); break; }
            $api->updateCasoTags($row, implode('/', $nv));
            DB::log($me, $caso_id, 'remove_tag', ['tags'=>$cur], ['tags'=>$nv]);
            $newVer = GoogleAPI::caseVersion($caso['ufs'], $caso['cidades'], $caso['clientes'], $nv, $caso['motivo_bloqueio']??'');
            echo json_encode(['ok'=>true,'tags'=>$nv,'ver'=>$newVer]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); }
        break;

    // Tags únicas em todos os casos (consumido pelo filtro da interface).
    case 'list_tags':
        try {
            $casos = $api->getCasos(false);
            $set = [];
            foreach ($casos as $c) foreach (($c['tags']??[]) as $t) if ($t !== '') $set[$t] = true;
            $list = array_keys($set); sort($list);
            echo json_encode(['ok'=>true,'tags'=>$list]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine(),'tags'=>[]]); }
        break;

    // Lista canônica de tags (vocabulário controlado). Bootstrap-migração:
    // na primeira execução (tags.json ausente) coleta as tags em uso em todas
    // as bases e usa como ponto de partida.
    case 'list_canonical_tags':
        try {
            $path = PRIVATE_CONFIG_PATH.'/tags.json';
            if (!file_exists($path)) {
                $set = [];
                $savedPrefix = DB::getPrefix();
                foreach (BASES as $bk => $bc) {
                    try {
                        DB::setPrefix($bc['db_prefix']);
                        $apiB = new GoogleAPI($bc);
                        foreach ($apiB->getCasos(false) as $c) {
                            foreach (($c['tags'] ?? []) as $t) {
                                if ($t !== '') $set[$t] = true;
                            }
                        }
                    } catch (Throwable $e) { /* ignora bases com erro */ }
                }
                DB::setPrefix($savedPrefix);
                $list = array_keys($set); sort($list);
                file_put_contents($path, json_encode($list, JSON_PRETTY_PRINT|JSON_UNESCAPED_UNICODE), LOCK_EX);
            }
            $tags = loadCanonicalTags();
            sort($tags);
            echo json_encode(['ok'=>true, 'tags'=>$tags]);
        } catch (Throwable $e) { echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine(),'tags'=>[]]); }
        break;

    // Adiciona uma tag à lista canônica (admin).
    case 'add_canonical_tag':
        requireAdmin($isAdmin);
        $tag = mb_strtoupper(trim($_POST['tag'] ?? ''), 'UTF-8');
        $tag = preg_replace('/[^\p{L}\p{N} \&\+\-]/u', '', $tag);
        $tag = trim(preg_replace('/\s+/', ' ', $tag));
        if ($tag === '' || mb_strlen($tag) > 30) {
            echo json_encode(['ok'=>false,'error'=>'Tag inválida (1–30 caracteres).']); break;
        }
        $duplicate = false;
        withJsonLock(PRIVATE_CONFIG_PATH.'/tags.json', function($list) use ($tag, &$duplicate) {
            if (!is_array($list)) $list = [];
            if (in_array($tag, $list, true)) { $duplicate = true; return null; }
            $list[] = $tag;
            sort($list);
            return $list;
        });
        if ($duplicate) {
            echo json_encode(['ok'=>true, 'msg'=>"Tag '{$tag}' já existia.", 'tags'=>loadCanonicalTags()]);
            break;
        }
        DB::log($me, 'sistema', 'add_canonical_tag', null, ['tag'=>$tag]);
        echo json_encode(['ok'=>true, 'msg'=>"Tag '{$tag}' adicionada.", 'tags'=>loadCanonicalTags()]);
        break;

    // Remove uma tag da lista canônica e em CASCATA de todos os casos em todas
    // as bases (admin). Em caso de falha parcial, devolve estatísticas.
    case 'remove_canonical_tag':
        requireAdmin($isAdmin);
        $tag = mb_strtoupper(trim($_POST['tag'] ?? ''), 'UTF-8');
        if ($tag === '') { echo json_encode(['ok'=>false,'error'=>'Tag não informada.']); break; }

        // 1. Remove da lista canônica.
        withJsonLock(PRIVATE_CONFIG_PATH.'/tags.json', function($list) use ($tag) {
            if (!is_array($list)) return null;
            return array_values(array_filter($list, fn($t) => $t !== $tag));
        });

        // 2. Cascata: remove dos casos em todas as bases.
        $totalAffected = 0;
        $errors = [];
        $savedPrefix = DB::getPrefix();
        foreach (BASES as $baseKey => $bc) {
            try {
                DB::setPrefix($bc['db_prefix']);
                $apiB = new GoogleAPI($bc);
                $cs = $apiB->getCasos(true);
                foreach ($cs as $c) {
                    $tags = $c['tags'] ?? [];
                    if (in_array($tag, $tags, true)) {
                        $newTags = array_values(array_filter($tags, fn($t) => $t !== $tag));
                        try {
                            $apiB->updateCasoTags($c['row'], implode('/', $newTags));
                            DB::log($me, $c['id'], 'remove_tag_cascade', ['tags'=>$tags], ['tags'=>$newTags]);
                            $totalAffected++;
                        } catch (Throwable $e) {
                            $errors[] = "{$baseKey}/{$c['id']}: ".$e->getMessage();
                        }
                    }
                }
            } catch (Throwable $e) {
                $errors[] = "base {$baseKey}: ".$e->getMessage();
            }
        }
        DB::setPrefix($savedPrefix);
        DB::log($me, 'sistema', 'remove_canonical_tag', ['tag'=>$tag], ['cases_affected'=>$totalAffected]);
        echo json_encode([
            'ok'=>true,
            'msg'=>"Tag '{$tag}' removida. {$totalAffected} caso(s) afetado(s).".(count($errors) ? " ".count($errors)." erro(s)." : ''),
            'cases_affected'=>$totalAffected,
            'errors'=>$errors,
            'tags'=>loadCanonicalTags(),
        ]);
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
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    // ── Exibição inline de uma foto/arquivo do Drive (lightbox) ─
    case 'view_photo':
        $fileId = preg_replace('/[^A-Za-z0-9_\-]/','',$_GET['file_id']??'');
        if (!$fileId) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'file_id inválido.']); break; }
        try {
            $r = $api->downloadDriveFile($fileId);
            if (!$r['ok']) { http_response_code(502); echo json_encode(['ok'=>false,'error'=>$r['error']??'Falha']); break; }
            // Substitui os headers JSON padrão por headers de imagem inline.
            header_remove('Content-Type');
            header_remove('X-Frame-Options');
            header('Content-Type: '.$r['mime']);
            header('Content-Length: '.strlen($r['data']));
            header('Content-Disposition: inline');
            header('Cache-Control: private, max-age=600');
            echo $r['data'];
            exit;
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
        }
        break;

    // ── Rendição grande (~1600px) para o visualizador ──────────
    // Muito menor que o original servido por view_photo; fica em cache no
    // mesmo diretório das thumbs ({fileId}_p.jpg) e nas próximas listagens o
    // enrichPhotos devolve preview_url apontando direto pro arquivo estático.
    case 'view_preview':
        $fileId = preg_replace('/[^A-Za-z0-9_\-]/','',$_GET['file_id']??'');
        if (!$fileId) { http_response_code(400); echo json_encode(['ok'=>false,'error'=>'file_id inválido.']); break; }
        try {
            $path = $thumbDir.'/'.$fileId.'_p.jpg';
            $mime = 'image/jpeg';
            if (file_exists($path) && filesize($path) > 100) {
                $data = file_get_contents($path);
            } else {
                $r = $api->downloadDrivePreview($fileId);
                // Arquivos sem rendição no Drive caem para o original.
                if (!$r['ok']) $r = $api->downloadDriveFile($fileId);
                if (!$r['ok']) { http_response_code(502); echo json_encode(['ok'=>false,'error'=>$r['error']??'Falha']); break; }
                $data = $r['data'];
                $mime = $r['mime'] ?? 'image/jpeg';
                if ($mime === 'image/jpeg') @file_put_contents($path, $data);
            }
            header_remove('Content-Type');
            header_remove('X-Frame-Options');
            header('Content-Type: '.$mime);
            header('Content-Length: '.strlen($data));
            header('Content-Disposition: inline');
            header('Cache-Control: private, max-age=86400');
            echo $data;
            exit;
        } catch (Throwable $e) {
            http_response_code(500);
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]);
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
        // Empacotar arquivos completos (vídeos inclusive) pode ser pesado. Damos
        // mais tempo/memória e gravamos cada arquivo num temporário em disco antes
        // de adicioná-lo: ZipArchive::addFile lê do disco só no close(), em vez de
        // manter todos os bytes na RAM ao mesmo tempo (como faria addFromString).
        @set_time_limit(300);
        if ((int)ini_get('memory_limit') !== -1) @ini_set('memory_limit', '512M');
        $MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024; // teto de segurança: 2 GB
        $tmpZip = tempnam(sys_get_temp_dir(), 'bi_zip_');
        $zip = new ZipArchive();
        if ($zip->open($tmpZip, ZipArchive::OVERWRITE) !== true) {
            @unlink($tmpZip);
            echo json_encode(['ok'=>false,'error'=>'Falha ao criar ZIP.']); break;
        }
        $errors     = [];
        $totalFiles = 0;
        $totalBytes = 0;
        $tmpFiles   = [];
        $limitHit   = false;
        try {
            foreach ($ids as $cid) {
                if ($limitHit) break;
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
                    $bytes = strlen($r['data']);
                    if ($totalBytes + $bytes > $MAX_TOTAL_BYTES) {
                        $errors[] = 'Limite de 2 GB por download atingido — selecione menos casos por vez.';
                        $limitHit = true; break;
                    }
                    $tmp = tempnam(sys_get_temp_dir(), 'bi_f_');
                    if ($tmp === false || @file_put_contents($tmp, $r['data']) === false) {
                        $errors[] = "$cid/{$r['name']}: falha ao gravar arquivo temporário";
                        if ($tmp !== false) @unlink($tmp);
                        continue;
                    }
                    $totalBytes += $bytes;
                    unset($r['data']); // libera a cópia em memória o quanto antes
                    $entry = $cid.'/'.preg_replace('/[\\\\\/:*?"<>|]/','_', $r['name']);
                    $zip->addFile($tmp, $entry);
                    $tmpFiles[] = $tmp;
                    $totalFiles++;
                }
            }
            $zip->close(); // só aqui o ZipArchive lê os temporários do disco
        } catch (Throwable $e) {
            @$zip->close(); @unlink($tmpZip);
            foreach ($tmpFiles as $tf) @unlink($tf);
            echo json_encode(['ok'=>false,'error'=>$e->getMessage(),'error_tipo'=>get_class($e),'error_origem'=>basename($e->getFile()).':'.$e->getLine()]); break;
        }
        if ($totalFiles === 0) {
            @unlink($tmpZip);
            foreach ($tmpFiles as $tf) @unlink($tf);
            echo json_encode(['ok'=>false,'error'=>'Nenhum arquivo encontrado para os IDs informados.', 'details'=>$errors]); break;
        }
        // Faz streaming do ZIP montado para o cliente e remove tudo em seguida.
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
        foreach ($tmpFiles as $tf) @unlink($tf);
        DB::log($me, 'sistema', 'download_bulk', null, ['ids'=>$ids,'files'=>$totalFiles,'errors'=>count($errors)]);
        exit;

    /*
     * Auditoria de qualidade dos dados (admin). Varre todos os casos de todas
     * as bases e devolve relatório de:
     *   - UFs inválidas (não estão nas 27 BR + marcadores de bloqueio)
     *   - Cidades não reconhecidas pelo CSV de coordenadas (com sugestões fuzzy)
     *   - Cidades cadastradas em UF que não consta no caso
     *   - Duplicatas com escritas diferentes no mesmo caso
     */
    case 'audit_data':
        requireAdmin($isAdmin);
        $VALID_UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO','NA','LINDA'];
        $report = [
            'csv_loaded'   => true,
            'csv_error'    => null,
            'uf_issues'    => [],
            'cidade_unknown' => [],
            'cidade_wrong_uf'=> [],
            'cidade_dups'  => [],
            'summary'      => [
                'bases'              => 0,
                'casos'              => 0,
                'uf_entries'         => 0,
                'cidade_entries'     => 0,
                'uf_invalid_count'   => 0,
                'cidade_unknown_count' => 0,
                'cidade_wrong_uf_count'=> 0,
                'cidade_dups_count'  => 0,
            ],
        ];

        $coordsCheck = loadCidadesCoords();
        if (isset($coordsCheck['_error'])) {
            $report['csv_loaded'] = false;
            $report['csv_error']  = $coordsCheck['_error'];
        }

        $savedPrefix = DB::getPrefix();
        foreach (BASES as $baseKey => $bc) {
            try {
                DB::setPrefix($bc['db_prefix']);
                $apiB = new GoogleAPI($bc);
                $cs = $apiB->getCasos(false);
                $report['summary']['bases']++;
                foreach ($cs as $c) {
                    $report['summary']['casos']++;

                    foreach (($c['ufs'] ?? []) as $uf) {
                        $report['summary']['uf_entries']++;
                        if (!in_array($uf, $VALID_UFS, true)) {
                            $report['uf_issues'][] = ['base'=>$baseKey, 'caso_id'=>$c['id'], 'uf'=>$uf];
                            $report['summary']['uf_invalid_count']++;
                        }
                    }

                    $normMap = [];
                    foreach (($c['cidades'] ?? []) as $cid) {
                        $report['summary']['cidade_entries']++;
                        if (!$cid) continue;
                        $norm = normalizeCidade($cid);

                        if (isset($normMap[$norm])) {
                            if ($normMap[$norm] !== $cid) {
                                $report['cidade_dups'][] = ['base'=>$baseKey, 'caso_id'=>$c['id'], 'a'=>$normMap[$norm], 'b'=>$cid, 'normalized'=>$norm];
                                $report['summary']['cidade_dups_count']++;
                            }
                        } else {
                            $normMap[$norm] = $cid;
                        }

                        if ($report['csv_loaded']) {
                            $matches = findCidadeAnywhere($norm);
                            if (empty($matches)) {
                                $sugs = suggestSimilarCidades($norm);
                                $report['cidade_unknown'][] = ['base'=>$baseKey, 'caso_id'=>$c['id'], 'cidade'=>$cid, 'suggestions'=>$sugs];
                                $report['summary']['cidade_unknown_count']++;
                            } else {
                                $caseUfs = $c['ufs'] ?? [];
                                $hitInCaseUf = false;
                                foreach ($matches as $m) {
                                    if (in_array($m['uf'], $caseUfs, true)) { $hitInCaseUf = true; break; }
                                }
                                if (!$hitInCaseUf && !empty($caseUfs)) {
                                    $report['cidade_wrong_uf'][] = [
                                        'base'=>$baseKey, 'caso_id'=>$c['id'], 'cidade'=>$cid,
                                        'found_in'=>array_values(array_unique(array_map(fn($m)=>$m['uf'], $matches))),
                                        'case_ufs'=>$caseUfs,
                                    ];
                                    $report['summary']['cidade_wrong_uf_count']++;
                                }
                            }
                        }
                    }
                }
            } catch (Throwable $e) {
                $report['errors'][] = "base {$baseKey}: ".$e->getMessage();
            }
        }
        DB::setPrefix($savedPrefix);
        echo json_encode(['ok'=>true, 'report'=>$report]);
        break;

    // Lê o raio mínimo de distância atualmente em vigor (admin).
    case 'get_distance_config':
        requireAdmin($isAdmin);
        echo json_encode([
            'ok'        => true,
            'radius_km' => defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80,
        ]);
        break;

    /*
     * Grava o raio mínimo de distância em `distance_config.json` (admin).
     * O novo valor passa a valer a partir da próxima requisição — a constante
     * DISTANCE_RADIUS_KM já foi definida no bootstrap deste request.
     */
    case 'set_distance_config':
        requireAdmin($isAdmin);
        $raw = $_POST['radius_km'] ?? '';
        if (!is_numeric($raw)) {
            echo json_encode(['ok'=>false,'error'=>'Valor inválido — informe um número em km.']); break;
        }
        $novoRaio = round((float)$raw, 1);
        if ($novoRaio < 1 || $novoRaio > 5000) {
            echo json_encode(['ok'=>false,'error'=>'Raio fora do intervalo permitido (1–5000 km).']); break;
        }
        $antigo = defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80;
        withJsonLock(PRIVATE_CONFIG_PATH.'/distance_config.json', function($d) use ($novoRaio) {
            if (!is_array($d)) $d = [];
            $d['radius_km'] = $novoRaio;
            return $d;
        });
        DB::log($me, 'sistema', 'set_distance_config', ['radius_km'=>$antigo], ['radius_km'=>$novoRaio]);
        echo json_encode(['ok'=>true,'radius_km'=>$novoRaio,'msg'=>"Raio atualizado para {$novoRaio} km. Vale a partir da próxima ação."]);
        break;

    // Lista as cidades coringa cadastradas em distance_overrides.json (admin).
    // Resolve o nome canônico de cada cidade pelo CSV de coordenadas.
    case 'list_distance_overrides':
        requireAdmin($isAdmin);
        $ovr = loadDistanceOverrides();
        $list = [];
        foreach ($ovr as $key => $raioOvr) {
            [$kUf, $kNorm] = array_pad(explode('|', $key, 2), 2, '');
            $c = findCidadeCoords($kUf, $kNorm);
            $list[] = [
                'key'       => $key,
                'uf'        => $kUf,
                'cidade'    => $c ? $c['name'] : $kNorm,
                'radius_km' => (float)$raioOvr,
                'known'     => (bool)$c,
            ];
        }
        usort($list, fn($a, $b) => strcmp($a['cidade'].$a['uf'], $b['cidade'].$b['uf']));
        echo json_encode([
            'ok'         => true,
            'overrides'  => $list,
            'default_km' => defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80,
        ]);
        break;

    // Cadastra/atualiza uma cidade coringa (admin). A cidade precisa existir no
    // CSV de coordenadas — caso contrário não há como calcular distâncias dela.
    case 'add_distance_override':
        requireAdmin($isAdmin);
        $ufIn  = strtoupper(trim($_POST['uf'] ?? ''));
        $cidIn = trim($_POST['cidade'] ?? '');
        $raw   = $_POST['radius_km'] ?? '';
        if (!is_numeric($raw)) {
            echo json_encode(['ok'=>false,'error'=>'Raio inválido — informe um número em km.']); break;
        }
        $raioOvr = round((float)$raw, 1);
        if ($raioOvr < 1 || $raioOvr > 5000) {
            echo json_encode(['ok'=>false,'error'=>'Raio fora do intervalo permitido (1–5000 km).']); break;
        }
        $padrao = defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80;
        if ($raioOvr > $padrao) {
            echo json_encode(['ok'=>false,'error'=>"O raio do coringa ({$raioOvr} km) não pode ser maior que o raio padrão ({$padrao} km) — cidade coringa serve para reduzir o raio."]); break;
        }
        $c = findCidadeCoords($ufIn, $cidIn);
        if (!$c) {
            echo json_encode(['ok'=>false,'error'=>"Cidade \"{$cidIn}/{$ufIn}\" não encontrada no CSV de coordenadas. Confira o nome e a UF."]); break;
        }
        $key = $c['uf'].'|'.normalizeCidade($c['name']);
        withJsonLock(PRIVATE_CONFIG_PATH.'/distance_overrides.json', function($d) use ($key, $raioOvr) {
            if (!is_array($d)) $d = [];
            $d[$key] = $raioOvr;
            return $d;
        });
        DB::log($me, 'sistema', 'add_distance_override', null, ['cidade'=>$c['name'],'uf'=>$c['uf'],'radius_km'=>$raioOvr]);
        echo json_encode(['ok'=>true,'msg'=>"Coringa {$c['name']}/{$c['uf']} salvo com raio de {$raioOvr} km. Vale a partir da próxima ação."]);
        break;

    // Remove uma cidade coringa (admin). A chave é "UF|CIDADE_NORMALIZADA".
    case 'remove_distance_override':
        requireAdmin($isAdmin);
        $key = trim($_POST['key'] ?? '');
        if ($key === '') { echo json_encode(['ok'=>false,'error'=>'Coringa não informado.']); break; }
        $removed = false;
        withJsonLock(PRIVATE_CONFIG_PATH.'/distance_overrides.json', function($d) use ($key, &$removed) {
            if (!is_array($d) || !isset($d[$key])) return null;
            unset($d[$key]);
            $removed = true;
            return $d;
        });
        if ($removed) DB::log($me, 'sistema', 'remove_distance_override', ['key'=>$key], null);
        echo json_encode(['ok'=>true,'msg'=>$removed ? 'Coringa removido.' : 'Coringa não estava cadastrado.']);
        break;

    /*
     * Auditoria de distâncias (admin). Simula a regra de raio mínimo sobre os
     * casos já existentes: varre todos os casos de todas as bases e detecta
     * pares de cidades DENTRO do mesmo caso cuja distância em linha reta
     * (Haversine) é menor ou igual a DISTANCE_RADIUS_KM. Aponta também as
     * cidades cujas coordenadas não puderam ser resolvidas no CSV.
     */
    case 'audit_distances':
        requireAdmin($isAdmin);
        $raio = defined('DISTANCE_RADIUS_KM') ? (float)DISTANCE_RADIUS_KM : 80;
        $report = [
            'radius_km'  => $raio,
            'csv_loaded' => true,
            'csv_error'  => null,
            'conflicts'  => [],
            'unresolved' => [],
            'errors'     => [],
            'summary'    => [
                'bases'            => 0,
                'casos'            => 0,
                'casos_conflito'   => 0,
                'conflict_count'   => 0,
                'unresolved_count' => 0,
            ],
        ];

        $coordsCheck = loadCidadesCoords();
        if (isset($coordsCheck['_error'])) {
            $report['csv_loaded'] = false;
            $report['csv_error']  = $coordsCheck['_error'];
            echo json_encode(['ok'=>true, 'report'=>$report]);
            break;
        }

        $savedPrefix = DB::getPrefix();
        foreach (BASES as $baseKey => $bc) {
            try {
                DB::setPrefix($bc['db_prefix']);
                $apiB = new GoogleAPI($bc);
                $cs = $apiB->getCasos(false);
                $report['summary']['bases']++;
                foreach ($cs as $c) {
                    $report['summary']['casos']++;
                    $caseUfs = $c['ufs'] ?? [];

                    // Resolve as coordenadas de cada cidade do caso, testando as
                    // UFs presentes no caso (mesma estratégia do formulário).
                    $pts = [];
                    foreach (($c['cidades'] ?? []) as $cid) {
                        if (!$cid) continue;
                        $co = findCidadeCoordsAmongUfs($cid, $caseUfs);
                        if ($co) {
                            $pts[] = ['cidade'=>$cid, 'uf'=>$co['uf'], 'lat'=>$co['lat'], 'lng'=>$co['lng']];
                        } else {
                            $report['unresolved'][] = ['base'=>$baseKey, 'caso_id'=>$c['id'], 'cidade'=>$cid];
                            $report['summary']['unresolved_count']++;
                        }
                    }

                    // Compara todos os pares de cidades resolvidas do caso. O raio
                    // de cada par é o MENOR entre os raios das duas cidades, de modo
                    // que uma cidade coringa aperta o limite de qualquer par seu.
                    $temConflito = false;
                    $n = count($pts);
                    for ($i = 0; $i < $n; $i++) {
                        for ($j = $i + 1; $j < $n; $j++) {
                            if (normalizeCidade($pts[$i]['cidade']) === normalizeCidade($pts[$j]['cidade'])) continue;
                            $d = haversineKm($pts[$i]['lat'], $pts[$i]['lng'], $pts[$j]['lat'], $pts[$j]['lng']);
                            $raioPar = min(
                                cidadeRadiusKm($pts[$i]['uf'], $pts[$i]['cidade']),
                                cidadeRadiusKm($pts[$j]['uf'], $pts[$j]['cidade'])
                            );
                            if ($d <= $raioPar) {
                                $report['conflicts'][] = [
                                    'base'=>$baseKey, 'caso_id'=>$c['id'],
                                    'cidade_a'=>$pts[$i]['cidade'], 'uf_a'=>$pts[$i]['uf'],
                                    'cidade_b'=>$pts[$j]['cidade'], 'uf_b'=>$pts[$j]['uf'],
                                    'distancia_km'=>round($d, 1),
                                    'raio_km'=>$raioPar,
                                ];
                                $report['summary']['conflict_count']++;
                                $temConflito = true;
                            }
                        }
                    }
                    if ($temConflito) $report['summary']['casos_conflito']++;
                }
            } catch (Throwable $e) {
                $report['errors'][] = "base {$baseKey}: ".$e->getMessage();
            }
        }
        DB::setPrefix($savedPrefix);
        echo json_encode(['ok'=>true, 'report'=>$report]);
        break;

    default:
        http_response_code(400);
        echo json_encode(['ok'=>false,'error'=>'Ação desconhecida.']);
}
