<?php
/**
 * Relatório V3 — ponte com a API de Marketing da Meta (Graph API).
 *
 * Recebe { account, since, until } de um usuário JÁ AUTENTICADO no sistema, consulta
 * os insights da conta de anúncios e devolve os números no MESMO formato tabular
 * que um export de Excel teria — as mesmas colunas que o parser do relatório
 * (discoverV2) já entende. Assim a V3 reaproveita 100% do motor da V2.
 *
 * Princípios de segurança:
 *   - Exige sessão do sistema (mesmo cookie bi_session) + token CSRF em POST.
 *   - O token da Meta NUNCA chega ao navegador: vive só em secrets.local.php.
 *   - Só leitura (ads_read): não gasta verba nem altera campanha.
 *   - Suporta várias BMs (META_TOKENS): um token por BM, escolhido conforme a conta.
 *
 * Persistência (v3-store.php, MySQL): a lista de contas, os relatórios prontos e
 * os criativos/foto são salvos para reduzir as chamadas à Meta (evitando
 * restrição) e tolerar quedas do token. Qualquer falha de banco degrada para
 * busca ao vivo — o cache nunca é ponto único de falha.
 *
 * Resposta de sucesso: { ok:true, main:[[...]], platform:[[...]], meta:{...} }
 *   onde main/platform são "array de arrays" (linha 0 = cabeçalhos).
 * Resposta de erro:    { ok:false, error:"mensagem em PT", code:"COD" } + HTTP.
 */

header('Content-Type: application/json; charset=utf-8');

/* Carimbo de versão do backend. BATA ESTE VALOR com o V3_BUILD do
   js/meta-api-v3.js a cada release: a tela do V3 mostra os dois lado a lado e
   avisa se divergirem — é assim que se confirma que o deploy realmente subiu. */
define('V3_BUILD', 'v3.10 · 2026-06-22');

/* Versão da LÓGICA DE CÁLCULO (resultado/criativos). Bumpe sempre que mudar como
   o "Resultado" é escolhido ou como os criativos são buscados: relatórios e
   criativos salvos com uma versão diferente são ignorados (recalculados sozinhos),
   sem precisar limpar o cache na mão. */
define('V3_CALC', '2026-06-22a');

/* Abaixo desta largura (px) a imagem é considerada de BAIXA qualidade (ex.: a Meta
   devolveu o thumbnail de 64px porque estrangulou a busca em alta) — não é salva
   no cache e o frontend alerta o usuário. */
define('V3_MIN_GOOD_PX', 300);

/* ── Probe de NÍVEL 0 (?probe=1) ──────────────────────────────────────────
   Responde IMEDIATAMENTE, antes de carregar config, sessão, token ou Meta —
   zero dependências. É o primeiro "bloco" do teste em etapas:
     • se ?probe=1 já dá 502 → o servidor não consegue nem executar este PHP
       (PHP-FPM/handler/.htaccess, ou o arquivo subiu corrompido) — não tem a
       ver com login, datas nem Meta;
     • se responde JSON → o PHP roda este arquivo e a versão (build) confirma
       que o deploy subiu. Aí o problema está num bloco posterior (ver ?ping=1). */
if (isset($_GET['probe'])) {
    echo json_encode(['ok' => true, 'probe' => true, 'build' => V3_BUILD, 'php' => PHP_VERSION, 'time' => date('c')], JSON_UNESCAPED_UNICODE);
    exit;
}

/* Breadcrumb de etapa + cronômetro: toda resposta de erro carrega em QUE bloco
   quebrou (step) e em quantos ms — é o "request em blocos" pedido, embutido em
   cada falha, para ver exatamente onde trava. */
$GLOBALS['v3_step'] = 'boot';
$GLOBALS['v3_t0']   = microtime(true);
$GLOBALS['v3_buc']  = 0;   // maior uso de cota visto nos headers da Meta nesta requisição
function v3_step($s) { $GLOBALS['v3_step'] = $s; }
function v3_ms() { return (int) round((microtime(true) - ($GLOBALS['v3_t0'] ?? microtime(true))) * 1000); }

/* Lê o cabeçalho x-business-use-case-usage da Meta e guarda o maior percentual
   de cota (call_count / cputime / time) observado, para o medidor de consumo. */
function v3_track_buc($headers) {
    if (!is_string($headers) || !preg_match('/x-business-use-case-usage:\s*(.+)/i', $headers, $m)) return;
    $j = json_decode(trim($m[1]), true);
    if (!is_array($j)) return;
    foreach ($j as $entries) {
        if (!is_array($entries)) continue;
        foreach ($entries as $u) {
            if (!is_array($u)) continue;
            foreach (['call_count', 'total_cputime', 'total_time'] as $k) {
                if (isset($u[$k])) $GLOBALS['v3_buc'] = max($GLOBALS['v3_buc'], (int) $u[$k]);
            }
        }
    }
}

/* Diagnóstico robusto: TODO erro precisa virar um JSON com mensagem, tipo e
   origem (arquivo:linha) — nunca uma página 500/502 em branco que o navegador
   só consegue ler como "resposta inválida". Para isso:
     - display_errors OFF, para warnings/notices não corromperem o corpo JSON;
     - ob_start(), para segurar a saída e poder descartá-la se ocorrer um fatal;
     - set_exception_handler para exceções;
     - register_shutdown_function para erros FATAIS (que o handler de exceção
       não pega: parse, memória, tempo esgotado) — a causa típica de um 502. */
error_reporting(E_ALL);
ini_set('display_errors', '0');
ob_start();

set_exception_handler(function (Throwable $e) {
    if (function_exists('ob_get_length') && ob_get_length()) { ob_clean(); }
    // 200 (não 500) para o Cloudflare não trocar o corpo pela página de erro dele.
    if (!headers_sent()) http_response_code(200);
    echo json_encode([
        'ok'           => false,
        'error'        => $e->getMessage(),
        'code'         => 'EXCEPTION',
        'http_hint'    => 500,
        'error_tipo'   => get_class($e),
        'error_origem' => basename($e->getFile()) . ':' . $e->getLine(),
        'step'         => $GLOBALS['v3_step'] ?? null,
        'ms'           => function_exists('v3_ms') ? v3_ms() : null,
    ], JSON_UNESCAPED_UNICODE);
});

register_shutdown_function(function () {
    $e = error_get_last();
    $fatal = $e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true);
    if ($fatal) {
        if (function_exists('ob_get_length') && ob_get_length()) { ob_clean(); }
        // 200 (não 500) para o Cloudflare não trocar o corpo pela página de erro dele.
        if (!headers_sent()) { http_response_code(200); header('Content-Type: application/json; charset=utf-8'); }
        echo json_encode([
            'ok'           => false,
            'error'        => 'Falha interna no servidor: ' . $e['message'],
            'code'         => 'FATAL',
            'http_hint'    => 500,
            'error_tipo'   => 'FatalError',
            'error_origem' => basename($e['file']) . ':' . $e['line'],
            'step'         => $GLOBALS['v3_step'] ?? null,
            'ms'           => function_exists('v3_ms') ? v3_ms() : null,
        ], JSON_UNESCAPED_UNICODE);
    }
    if (ob_get_level() > 0) { @ob_end_flush(); }   // entrega a saída normal
});

/* ── 1) Localiza e carrega a config privada ───────────────────────────────
   Sobe diretórios até achar private-config/config.php, de modo a funcionar
   tanto local (raizdosite/) quanto no servidor, sem depender da profundidade. */
$cfgPath = null;
$dir = __DIR__;
for ($i = 0; $i < 6; $i++) {
    $cand = $dir . '/private-config/config.php';
    if (is_file($cand)) { $cfgPath = $cand; break; }
    $dir = dirname($dir);
}
if (!$cfgPath) {
    http_response_code(200);   // 200 p/ o Cloudflare não mascarar o corpo (ver fail())
    echo json_encode(['ok' => false, 'error' => 'Configuração do servidor não encontrada.', 'code' => 'NO_CONFIG', 'http_hint' => 500], JSON_UNESCAPED_UNICODE);
    exit;
}
require_once $cfgPath;
v3_step('config_loaded');

/* Persistência (perfis, cache de relatórios/criativos, log de consumo). Opcional
   e resiliente: se a lib ou o banco não responderem, $V3_HAS_STORE fica false e
   tudo segue ao vivo. A limpeza diária dos relatórios antigos é disparada aqui
   por demanda (piggyback), no máximo uma vez por dia — sem cron. */
$V3_HAS_STORE = false;
$storeLib = PRIVATE_CONFIG_PATH . '/lib/v3-store.php';
if (is_file($storeLib)) {
    require_once $storeLib;
    if (class_exists('V3Store')) {
        $V3_HAS_STORE = V3Store::setup();
        if ($V3_HAS_STORE) V3Store::dailyCleanup();
    }
}

/* ── 2) Sessão idêntica ao handler.php → compartilha o login do sistema ──── */
$sessionDir = PRIVATE_CONFIG_PATH . '/sessions';
if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
ini_set('session.save_path',       $sessionDir);
ini_set('session.gc_maxlifetime',  SESSION_LIFETIME);
ini_set('session.cookie_lifetime', SESSION_LIFETIME);
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
v3_step('session');

/* Garante um token CSRF na sessão (igual ao handler.php) para validar o POST. */
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));

/** Responde um erro em JSON e encerra. $extra acrescenta campos de diagnóstico
    (ex.: error_tipo, error_origem) que o frontend exibe junto da mensagem. */
function fail($code, $msg, $http = 400, array $extra = []) {
    // IMPORTANTE: o Cloudflare SUBSTITUI o corpo de respostas 5xx do origin pela
    // própria página "Bad gateway", engolindo nosso JSON — foi por isso que erros
    // reais (token inválido etc.) apareciam como um 502 sem explicação. Por isso
    // erro de APLICAÇÃO nunca sai como 5xx: rebaixa para 200 (com ok:false +
    // code), e o status pretendido vai em http_hint só para referência. O cliente
    // sempre lê ok/code do CORPO, não do status HTTP.
    $hint = $http;
    if ($http >= 500) $http = 200;
    if (!headers_sent()) http_response_code($http);
    $base = ['ok' => false, 'error' => $msg, 'code' => $code, 'http_hint' => $hint,
             'step' => $GLOBALS['v3_step'] ?? null, 'ms' => function_exists('v3_ms') ? v3_ms() : null];
    echo json_encode(array_merge($base, $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

/* ── 3) Exige login do sistema ────────────────────────────────────────────
   Só a V3 é protegida; V1/V2 (subir Excel) continuam abertas. */
if (empty($_SESSION['user'])) {
    fail('AUTH', 'Você precisa estar logado para usar a V3.', 401);
}
if (isset($_SESSION['login_time']) && (time() - $_SESSION['login_time']) > SESSION_LIFETIME) {
    fail('SESSION_EXPIRED', 'Sua sessão expirou. Faça login novamente.', 401);
}
v3_step('auth_ok');

/* ── 4) Método + CSRF (mesma proteção do handler.php para POST) ──────────── */
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'POST') {
    $sent = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    if (!is_string($sent) || empty($_SESSION['csrf']) || !hash_equals($_SESSION['csrf'], $sent)) {
        fail('CSRF', 'Token de segurança inválido. Recarregue a página e tente de novo.', 403);
    }
}
$_SESSION['login_time'] = time(); // renova a janela de sessão, como o handler faz

/* ── 5) Entrada ───────────────────────────────────────────────────────────
   Aceita JSON no corpo (POST) ou querystring (GET, útil para depurar). */
$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) $body = [];
$body += $_GET;
$accountId   = preg_replace('/[^0-9]/', '', (string)($body['account'] ?? ''));
$month       = trim((string)($body['month'] ?? ''));   // formato AAAA-MM
$debug       = (string)($body['debug'] ?? '');          // '1' = tipos de ação · '2' = comparação
$refresh     = !empty($body['refresh']);                // ignora o cache e repuxa da Meta
$prefetch    = !empty($body['prefetch']);               // backfill de histórico: só dados (sem criativos/foto)
$action      = (string)($body['action'] ?? '');         // '' relatório · set_photo · refresh_photo · anomaly
$usuario     = (string)($_SESSION['user'] ?? '');
$clientLabel = trim((string)($body['label'] ?? ''));    // rótulo do cliente (do seletor) p/ o perfil

/* ── 6) Tokens (uma BM = um token) + lista de contas ──────────────────────
   Suporta VÁRIAS BMs: META_TOKENS é uma lista [{label, token}]. Mantém
   compatibilidade com o token único antigo (META_ACCESS_TOKEN). Cada conta
   carrega o índice 't' da BM/token a que pertence. */
$tokens = [];
if (defined('META_TOKENS') && is_array(META_TOKENS)) {
    foreach (META_TOKENS as $i => $t) {
        $tok = trim((string)($t['token'] ?? ''));
        if ($tok === '') continue;
        $tokens[] = ['label' => (string)($t['label'] ?? ('BM' . ($i + 1))), 'token' => $tok];
    }
}
if (!$tokens && defined('META_ACCESS_TOKEN') && META_ACCESS_TOKEN !== '') {
    $tokens[] = ['label' => 'Meta', 'token' => META_ACCESS_TOKEN];
}

/* ── Diagnóstico rápido (?ping=1) ─────────────────────────────────────────
   Confirma que o endpoint EXECUTA e responde JSON SEM tocar na Meta. Se o
   ping responde mas a listagem normal dá 502, a falha está na chamada à Graph
   API (timeout do gateway/PHP-FPM esperando a Meta), não no PHP em si. Exige
   login (já validado acima). Abra direto no navegador, logado:
       /relatorio/api/v3-meta-insights.php?ping=1                               */
if (isset($_GET['ping'])) {
    echo json_encode([
        'ok'          => true,
        'ping'        => true,
        'build'       => V3_BUILD,
        'file_mtime'  => date('c', (int) @filemtime(__FILE__)),  // data real do .php no servidor
        'php'         => PHP_VERSION,
        'curl'        => function_exists('curl_init'),
        'store'       => $V3_HAS_STORE,                            // banco do cache acessível?
        'api_version' => defined('META_API_VERSION') ? META_API_VERSION : null,
        'tokens'      => count($tokens),
        'curated'     => defined('META_ACCOUNTS') && is_array(META_ACCOUNTS) && count(META_ACCOUNTS) > 0,
        'user'        => $_SESSION['user'],
        'time'        => date('c'),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/* ── Self-test de rede (?selftest=1) ──────────────────────────────────────
   É o BLOCO 2 (chamada à Meta) instrumentado: faz a MESMA requisição da
   listagem (me/adaccounts), mas com timeout curto e trace completo (DNS,
   connect, TLS, HTTP, errno) e SEMPRE devolve JSON — nunca derruba o worker.
   Se a listagem normal dá 502 mas isto responde, o JSON mostra exatamente
   onde a rede falha. Se isto também der 502, o cURL está crashando o PHP
   (ver log do PHP-FPM / dmesg por "segfault"). */
if (isset($_GET['selftest'])) {
    v3_step('selftest');
    /*
     * Validação POR CAMADA, em modos isolados (rode um por vez, cada um num
     * request separado). Um crash do worker (segfault) é INCAPTURÁVEL por
     * try/catch — então a forma de "validar se é o cURL e que tipo" é ver QUAL
     * modo devolve JSON e qual derruba (502). Cada operação está num try/catch
     * para reportar o que FOR capturável (exceção/erro de tipo) com o tipo.
     *
     *   ?selftest=dns     → resolve DNS em PHP puro (sem cURL)
     *   ?selftest=socket  → conecta TCP+TLS em PHP puro (sem cURL) → isola "é o cURL?"
     *   ?selftest=connect → cURL só handshake (CONNECT_ONLY), blindado
     *   ?selftest=h2      → cURL request completo com HTTP/2 e IPv6 no PADRÃO (o suspeito)
     *   ?selftest=full|1  → cURL request completo BLINDADO (1.1 + IPv4 + NOSIGNAL)
     *
     * Leitura: se 'socket' funciona mas 'h2' derruba e 'full' funciona → era o
     * cURL com HTTP/2/IPv6 (a blindagem resolve). Se 'socket' já derruba/falha →
     * rede/TLS/firewall do host (não é o cURL). Se TUDO que usa cURL derruba até
     * 'connect' → cURL crashando: ver log do PHP-FPM/dmesg por "segfault".
     */
    $mode = strtolower((string) $_GET['selftest']);
    if ($mode === '1' || $mode === '') $mode = 'full';
    $host = 'graph.facebook.com';
    $ver  = defined('META_API_VERSION') ? META_API_VERSION : 'v21.0';
    $tok  = $tokens[0]['token'] ?? '';
    $out  = ['ok' => false, 'selftest' => true, 'mode' => $mode, 'build' => V3_BUILD, 'step' => 'selftest:' . $mode];

    if (function_exists('curl_version')) {
        $cv = curl_version();
        $out['curl_version'] = $cv['version'] ?? null;
        $out['ssl_version']  = $cv['ssl_version'] ?? null;
        $out['http2']        = defined('CURL_VERSION_HTTP2') ? (bool) (($cv['features'] ?? 0) & CURL_VERSION_HTTP2) : null;
    } else {
        $out['curl_version'] = null;
    }

    try {
        if ($mode === 'dns') {
            $t0  = microtime(true);
            $ips = @gethostbynamel($host);
            $out['ok']  = is_array($ips) && count($ips) > 0;
            $out['ips'] = $ips ?: [];
            $out['ms']  = (int) round((microtime(true) - $t0) * 1000);
        } elseif ($mode === 'socket') {
            // TCP+TLS via PHP puro (SEM cURL): se ISTO funciona e o cURL não, o
            // problema é o cURL; se ISTO falha, é rede/TLS/firewall do servidor.
            $t0 = microtime(true); $en = 0; $es = '';
            $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
            $fp  = @stream_socket_client('ssl://' . $host . ':443', $en, $es, 6, STREAM_CLIENT_CONNECT, $ctx);
            $out['ok']     = (bool) $fp;
            $out['errno']  = $en;
            $out['errstr'] = $es;
            $out['ms']     = (int) round((microtime(true) - $t0) * 1000);
            if ($fp) fclose($fp);
        } else {
            if (!function_exists('curl_init')) {
                $out['error'] = 'cURL ausente no PHP'; echo json_encode($out, JSON_UNESCAPED_UNICODE); exit;
            }
            $vlog = fopen('php://temp', 'w+');
            $u    = 'https://' . $host . '/' . $ver . '/me/adaccounts?' . http_build_query(['fields' => 'account_id,name', 'limit' => 5]);
            $opts = [
                CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_CONNECTTIMEOUT => 6,
                CURLOPT_NOSIGNAL => true, CURLOPT_VERBOSE => true, CURLOPT_STDERR => $vlog,
                CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $tok],
            ];
            if ($mode === 'connect') {
                $opts[CURLOPT_CONNECT_ONLY] = true;                      // só TCP+TLS, sem request
                $opts[CURLOPT_HTTP_VERSION] = CURL_HTTP_VERSION_1_1;
                $opts[CURLOPT_IPRESOLVE]    = CURL_IPRESOLVE_V4;
            } elseif ($mode === 'h2') {
                // de propósito: HTTP/2 e IPv6 no padrão — para flagrar se é isso que derruba
            } else { // full
                $opts[CURLOPT_HTTP_VERSION] = CURL_HTTP_VERSION_1_1;
                $opts[CURLOPT_IPRESOLVE]    = CURL_IPRESOLVE_V4;
            }
            $ch  = curl_init($u); curl_setopt_array($ch, $opts);
            $raw = curl_exec($ch); $errno = curl_errno($ch); $cerr = curl_error($ch); $info = curl_getinfo($ch);
            curl_close($ch);
            rewind($vlog); $vt = stream_get_contents($vlog); fclose($vlog);
            $vt = preg_replace('/(Bearer|access_token=)\s*\S+/i', '$1 ***', (string) $vt);  // nunca vaza o token
            $out['ok']         = $errno === 0;
            $out['errno']      = $errno;
            $out['curl_error'] = $cerr;
            $out['http_code']  = $info['http_code'] ?? null;
            $out['primary_ip'] = $info['primary_ip'] ?? null;
            $out['timing_s']   = [
                'dns'     => $info['namelookup_time'] ?? null,
                'connect' => $info['connect_time'] ?? null,
                'tls'     => $info['appconnect_time'] ?? null,
                'total'   => $info['total_time'] ?? null,
            ];
            if ($mode !== 'connect') $out['response_head'] = mb_substr((string) $raw, 0, 300);
            $out['verbose'] = array_slice(array_filter(explode("\n", trim((string) $vt))), -40);
        }
    } catch (Throwable $e) {
        // Captura o que FOR capturável (exceção/erro de tipo) com o tipo exato.
        $out['ok'] = false;
        $out['error']        = $e->getMessage();
        $out['error_tipo']   = get_class($e);
        $out['error_origem'] = basename($e->getFile()) . ':' . $e->getLine();
    }
    echo json_encode($out, JSON_UNESCAPED_UNICODE);
    exit;
}

if (!$tokens) {
    fail('NOT_CONFIGURED', 'A API da Meta ainda não foi configurada no servidor (nenhum token). Veja relatorio/DEPLOY-V3.md.', 503);
}
v3_step('tokens');

/* Ações do gerenciador de perfis (modal da tela inicial). Independem de período. */
if ($action === 'profiles_overview') {
    echo json_encode(['ok' => true, 'store' => $V3_HAS_STORE,
        'profiles' => $V3_HAS_STORE ? V3Store::profilesOverview() : [],
        'usage'    => $V3_HAS_STORE ? V3Store::usageToday() : null], JSON_UNESCAPED_UNICODE);
    exit;
}
if ($action === 'creatives') {
    echo json_encode(['ok' => true, 'creatives' => $V3_HAS_STORE ? V3Store::getAllCreatives($accountId) : []], JSON_UNESCAPED_UNICODE);
    exit;
}
if ($action === 'clear_profile') {
    if ($V3_HAS_STORE) V3Store::clearProfileCache($accountId);
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}
if ($action === 'remove_photo') {
    $ti = (int)($body['t'] ?? 0); if ($ti < 0 || $ti >= count($tokens)) $ti = 0;
    if ($V3_HAS_STORE) V3Store::removePhoto($accountId, $tokens[$ti]['label']);
    echo json_encode(['ok' => true], JSON_UNESCAPED_UNICODE);
    exit;
}

$accounts = defined('META_ACCOUNTS') ? META_ACCOUNTS : [];
$normAccts = array_values(array_filter(array_map(function ($a) {
    return [
        'label'  => (string)($a['label'] ?? ($a['act_id'] ?? '')),
        'act_id' => preg_replace('/[^0-9]/', '', (string)($a['act_id'] ?? '')),
        't'      => (int)($a['bm'] ?? 0),   // índice da BM/token (modo curado)
    ];
}, $accounts), function ($a) { return $a['act_id'] !== ''; }));
$curated = count($normAccts) > 0;   // lista manual preenchida = allowlist fixa

if ($accountId === '') {
    // Sem conta escolhida → devolve a lista para o seletor de perfis. Usa o cache
    // de 24h (zero chamada à Meta) salvo quando $refresh força a atualização. Em
    // modo automático (META_ACCOUNTS vazio), a lista é obtida de CADA BM via
    // /me/adaccounts e cada conta vira/atualiza um perfil.
    $listKey = 'accts:' . substr(sha1(implode('|', array_column($tokens, 'token'))), 0, 16);
    $cachedList = (!$refresh && $V3_HAS_STORE) ? V3Store::getAccountList($listKey) : null;
    $origin = 'cache';
    if ($cachedList === null) {
        $origin = 'live';
        $list = [];
        if ($curated) {
            foreach ($normAccts as $a) {
                $ti = ($a['t'] >= 0 && $a['t'] < count($tokens)) ? $a['t'] : 0;
                $list[] = ['label' => $a['label'], 'act_id' => $a['act_id'], 't' => $ti, 'bm' => $tokens[$ti]['label']];
            }
        } else {
            foreach ($tokens as $ti => $tk) {
                v3_step('meta:me/adaccounts t=' . $ti);   // se travar, o erro diz qual BM
                foreach (metaFetchAccounts($tk['token']) as $acc) {
                    $acc['t'] = $ti; $acc['bm'] = $tk['label'];
                    $list[] = $acc;
                }
            }
            usort($list, function ($a, $b) { return strcasecmp($a['label'], $b['label']); });
        }
        if ($V3_HAS_STORE) {
            foreach ($list as $a) V3Store::upsertProfile($a['act_id'], $a['bm'] ?? '', $a['label']);
            V3Store::setAccountList($listKey, $list);
            V3Store::logCall($usuario, '', 'accounts', v3_ms(), 200, $GLOBALS['v3_buc'], false);
        }
    } else {
        $list = $cachedList;
        if ($V3_HAS_STORE) V3Store::logCall($usuario, '', 'accounts', v3_ms(), 200, 0, true);
    }
    // Marca quais perfis já têm foto salva, para o seletor indicar.
    if ($V3_HAS_STORE) {
        foreach ($list as &$a) { $a['has_photo'] = V3Store::hasPhoto($a['act_id'], $a['bm'] ?? ''); }
        unset($a);
    }
    echo json_encode([
        'ok' => true, 'build' => V3_BUILD, 'ms' => v3_ms(), 'accounts' => $list,
        'auto' => !$curated, 'multi' => count($tokens) > 1, 'csrf' => $_SESSION['csrf'],
        'origin' => $origin, 'usage' => ($V3_HAS_STORE ? V3Store::usageToday() : null),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

/* ── Ações de foto do perfil (não dependem de período) ─────────────────────
   set_photo: grava uma foto enviada manualmente pelo usuário.
   refresh_photo: re-busca a foto da Página vinculada e regrava no perfil. */
if ($action === 'set_photo' || $action === 'refresh_photo') {
    $tIdx = (int)($body['t'] ?? 0);
    if ($tIdx < 0 || $tIdx >= count($tokens)) $tIdx = 0;
    $activeToken = $tokens[$tIdx]['token'];

    if ($action === 'set_photo') {
        if (!$V3_HAS_STORE) fail('NO_STORE', 'Persistência indisponível no servidor — não dá para salvar a foto agora.', 503);
        if (!preg_match('#^data:(image/[a-z.+-]+);base64,(.+)$#i', (string)($body['photo'] ?? ''), $m)) {
            fail('BAD_PHOTO', 'Imagem inválida. Envie um arquivo de imagem.');
        }
        $bytes = base64_decode($m[2], true);
        if ($bytes === false || strlen($bytes) > 3000000) fail('BAD_PHOTO', 'Imagem inválida ou grande demais (máx. ~3 MB).');
        V3Store::setProfilePhoto($accountId, $tokens[$tIdx]['label'], $clientLabel, base64_encode($bytes), $m[1], 'manual');
        echo json_encode(['ok' => true, 'photo' => 'data:' . $m[1] . ';base64,' . base64_encode($bytes), 'source' => 'manual'], JSON_UNESCAPED_UNICODE);
        exit;
    }

    // refresh_photo
    $pg = metaGetSoft('act_' . $accountId . '/promote_pages', ['fields' => 'name,picture.width(320).height(320)', 'limit' => 1], $activeToken);
    if ($V3_HAS_STORE) V3Store::logCall($usuario, $accountId, 'photo', v3_ms(), 200, $GLOBALS['v3_buc'], false);
    $purl = $pg['data'][0]['picture']['data']['url'] ?? '';
    if ($purl === '') fail('NO_PHOTO', 'A conta não tem uma Página com foto acessível pelo token. Envie a foto manualmente.', 200);
    $b = metaFetchBytes($purl);
    if (!$b) fail('NO_PHOTO', 'Não consegui baixar a foto da Página agora. Tente de novo ou envie manualmente.', 200);
    if ($V3_HAS_STORE) V3Store::setProfilePhoto($accountId, $tokens[$tIdx]['label'], $clientLabel, $b['b64'], $b['mime'], 'auto');
    echo json_encode(['ok' => true, 'photo' => 'data:' . $b['mime'] . ';base64,' . $b['b64'], 'source' => 'auto'], JSON_UNESCAPED_UNICODE);
    exit;
}

/* Análise de anomalias: compara o mês pedido com o mês ANTERIOR (ambos do cache)
   e devolve as mudanças relevantes. Não toca na Meta. */
if ($action === 'anomaly') {
    $aSince = trim((string)($body['since'] ?? ''));
    $aUntil = trim((string)($body['until'] ?? ''));
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $aSince) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $aUntil)) {
        echo json_encode(['ok' => true, 'anomalies' => [], 'reason' => 'periodo_invalido'], JSON_UNESCAPED_UNICODE); exit;
    }
    $prevSince = date('Y-m-01', strtotime($aSince . ' -1 month'));
    $prevUntil = date('Y-m-t', strtotime($prevSince));
    $cur  = $V3_HAS_STORE ? V3Store::getReport($accountId, $aSince, $aUntil) : null;
    $prev = $V3_HAS_STORE ? V3Store::getReport($accountId, $prevSince, $prevUntil) : null;
    if (!$cur || !$prev) {
        echo json_encode(['ok' => true, 'anomalies' => [], 'reason' => 'mes_anterior_indisponivel', 'prev_period' => [$prevSince, $prevUntil]], JSON_UNESCAPED_UNICODE); exit;
    }
    $A = v3_aggregate($cur['payload']);
    $B = v3_aggregate($prev['payload']);
    echo json_encode(['ok' => true, 'anomalies' => v3_anomalies($A, $B), 'cur' => $A, 'prev' => $B, 'prev_period' => [$prevSince, $prevUntil]], JSON_UNESCAPED_UNICODE);
    exit;
}

// Período: aceita intervalo since/until (AAAA-MM-DD) OU um mês (AAAA-MM, compat).
$since = trim((string)($body['since'] ?? ''));
$until = trim((string)($body['until'] ?? ''));
if ($since === '' || $until === '') {
    if (!preg_match('/^\d{4}-\d{2}$/', $month)) fail('BAD_PERIOD', 'Informe um período (de/até) ou um mês (AAAA-MM).');
    $since = $month . '-01';
    $until = date('Y-m-t', strtotime($since));
}
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $since) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $until)) {
    fail('BAD_PERIOD', 'Datas inválidas (use AAAA-MM-DD).');
}
if (strtotime($since) > strtotime($until)) fail('BAD_PERIOD', 'A data inicial está depois da final.');
// Qual token usar nesta consulta: o índice 't' (BM) que veio do seletor. Sem
// isso, usa o primeiro. A própria Meta barra se o token não puder ler a conta.
$tIdx = (int)($body['t'] ?? 0);
if ($tIdx < 0 || $tIdx >= count($tokens)) $tIdx = 0;
$activeToken = $tokens[$tIdx]['token'];
$bmLabel = $tokens[$tIdx]['label'];
// Allowlist: havendo lista manual, a conta precisa estar nela. Sem lista manual
// (modo automático), confiamos nos tokens — a Meta recusa contas fora da BM.
if ($curated) {
    $allowed = false;
    foreach ($normAccts as $a) { if ($a['act_id'] === $accountId) { $allowed = true; break; } }
    if (!$allowed) fail('ACCOUNT_NOT_ALLOWED', 'Essa conta não está na lista META_ACCOUNTS. Apague a lista para liberar todas as contas dos tokens, ou inclua esta conta.', 403);
}

/* ── 7) Relatório salvo: serve do cache quando válido (zero chamada à Meta) ─
   Período consolidado é imutável (cacheia por até RETENTION_DAYS); período
   ainda em andamento usa TTL curto. $refresh e os modos ?debug ignoram o cache. */
$isFinal = $V3_HAS_STORE ? V3Store::isFinal($until) : false;
if ($V3_HAS_STORE && !$refresh && $debug === '') {
    $cached = V3Store::getReport($accountId, $since, $until);
    if ($cached && (($cached['payload']['meta']['calc'] ?? '') !== V3_CALC)) $cached = null;   // cálculo mudou → recalcula
    if ($cached) {
        $p = $cached['payload'];
        $pp = V3Store::getProfilePhoto($accountId, $bmLabel);   // foto sempre do perfil atual
        if ($pp && isset($p['extras']) && is_array($p['extras'])) { $p['extras']['photo'] = $pp; $p['extras']['photo_source'] = 'profile'; }
        // Garante as imagens do Top 5 mesmo se o cache veio só com dados (backfill).
        // Reusa o cache de criativos (DB) → 0 chamada à Meta quando já baixados.
        if (!$prefetch) {
            $tm = ['cached' => 0, 'fetched' => 0, 'failed' => 0, 'low_quality' => 0, 'low_quality_names' => []];
            $th = v3_fetch_top_creatives($p['main'] ?? [], (array)($p['meta']['ad_ids'] ?? []), $accountId, $activeToken, false, $V3_HAS_STORE, $tm);
            if (!isset($p['extras']) || !is_array($p['extras'])) $p['extras'] = [];
            $p['extras']['thumbs'] = $th ?: (object) [];
            if (isset($p['meta']) && is_array($p['meta'])) $p['meta']['thumbs'] = $tm;
        }
        $p['origin']    = 'cache';
        $p['cached_at'] = $cached['fetched_at'];
        $p['usage']     = V3Store::usageToday();
        if (isset($p['meta']) && is_array($p['meta'])) $p['meta']['from_cache'] = true;
        V3Store::logCall($usuario, $accountId, 'report', v3_ms(), 200, 0, true);
        echo json_encode($p, JSON_UNESCAPED_UNICODE);
        exit;
    }

    /* Reaproveita um relatório MAIOR já salvo (ex.: o mensal) recortando os dias
       do intervalo pedido — serve quinzena/personalizado sem nova chamada à Meta. */
    $cover = V3Store::findCoveringReport($accountId, $since, $until);
    if ($cover && (($cover['payload']['meta']['calc'] ?? '') !== V3_CALC)) $cover = null;   // cálculo mudou → não deriva de versão antiga
    if ($cover && ($cover['since'] !== $since || $cover['until'] !== $until)) {
        $cp    = $cover['payload'];
        $main2 = v3_slice_aoa($cp['main'] ?? [], $since, $until);
        $plat2 = (isset($cp['platform']) && is_array($cp['platform'])) ? v3_slice_aoa($cp['platform'], $since, $until) : null;
        if (count($main2) > 1) {
            $d = $cp;
            $pp = V3Store::getProfilePhoto($accountId, $bmLabel);   // foto sempre do perfil atual
            if ($pp && isset($d['extras']) && is_array($d['extras'])) { $d['extras']['photo'] = $pp; $d['extras']['photo_source'] = 'profile'; }
            $d['main']     = $main2;
            $d['platform'] = ($plat2 && count($plat2) > 1) ? $plat2 : null;
            if (!$prefetch) {
                $tm = ['cached' => 0, 'fetched' => 0, 'failed' => 0, 'low_quality' => 0, 'low_quality_names' => []];
                $th = v3_fetch_top_creatives($main2, (array)($cp['meta']['ad_ids'] ?? []), $accountId, $activeToken, false, $V3_HAS_STORE, $tm);
                if (!isset($d['extras']) || !is_array($d['extras'])) $d['extras'] = [];
                $d['extras']['thumbs'] = $th ?: (object) [];
            }
            if (isset($d['meta']) && is_array($d['meta'])) {
                $d['meta']['since']         = $since;
                $d['meta']['until']         = $until;
                $d['meta']['rows_main']     = count($main2) - 1;
                $d['meta']['rows_platform'] = $plat2 ? count($plat2) - 1 : 0;
                $d['meta']['from_cache']    = true;
                if (isset($tm)) $d['meta']['thumbs'] = $tm;
            }
            $d['origin']       = 'derived';
            $d['derived_from'] = ['since' => $cover['since'], 'until' => $cover['until']];
            $d['cached_at']    = $cover['fetched_at'];
            $d['usage']        = V3Store::usageToday();
            V3Store::logCall($usuario, $accountId, 'report', v3_ms(), 200, 0, true);
            echo json_encode($d, JSON_UNESCAPED_UNICODE);
            exit;
        }
    }
}

/* Lista as contas de anúncios que o token enxerga (modo automático, usado
   quando META_ACCOUNTS está vazio). Adicionar um cliente passa a ser só fazer a
   parceria/atribuição na Meta — sem editar arquivo no servidor. */
function metaFetchAccounts($token) {
    $rows = metaGet('me/adaccounts', ['fields' => 'account_id,name', 'limit' => 200], $token, 12);
    $out = [];
    foreach ($rows as $r) {
        $id = preg_replace('/[^0-9]/', '', (string)($r['account_id'] ?? ''));
        if ($id === '') continue;
        $out[] = ['label' => (string)($r['name'] ?? $id), 'act_id' => $id];
    }
    usort($out, function ($a, $b) { return strcasecmp($a['label'], $b['label']); });
    return $out;
}

/* ── 8) Chamada genérica à Graph API (cURL + paginação) ───────────────────
   O token vai no header Authorization (não na URL, para não vazar em logs).
   Os headers de resposta são lidos para registrar o uso de cota da Meta. */
function metaGet($path, array $params, $token, $timeout = 45) {
    if (!function_exists('curl_init')) {
        fail('NO_CURL', 'A extensão cURL do PHP não está habilitada no servidor — sem ela não dá para falar com a Meta.', 500,
            ['error_tipo' => 'MissingExtension', 'error_origem' => 'metaGet(' . $path . ')']);
    }
    $base = 'https://graph.facebook.com/' . META_API_VERSION . '/' . ltrim($path, '/');
    $url  = $base . '?' . http_build_query($params);
    $out  = [];
    $guard = 0;
    while ($url && $guard++ < 60) {
        v3_step('curl:' . $path);   // se o worker morrer aqui, o step aponta a chamada
        $ch = curl_init($url);
        $respHeaders = '';
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) { $respHeaders .= $line; return strlen($line); },
            // Timeout abaixo do timeout típico do gateway (proxy_read_timeout
            // ~60s); assim, se a Meta travar, o PHP devolve um erro JSON em vez
            // de a requisição morrer como um 502 em branco do servidor. A
            // listagem de contas usa um limite mais curto (deveria ser rápida).
            CURLOPT_TIMEOUT        => $timeout,
            CURLOPT_CONNECTTIMEOUT => 15,
            // Blindagem contra crash do worker PHP-FPM no cURL/TLS (causa de 502
            // sem retorno): NOSIGNAL evita o uso de SIGALRM (crash em ambiente
            // com threads); HTTP/1.1 evita bugs de multiplexação do HTTP/2; IPv4
            // evita travar/crashar quando o IPv6 da máquina não tem rota.
            CURLOPT_NOSIGNAL       => true,
            CURLOPT_HTTP_VERSION   => CURL_HTTP_VERSION_1_1,
            CURLOPT_IPRESOLVE      => CURL_IPRESOLVE_V4,
            CURLOPT_HTTPHEADER     => ['Accept: application/json', 'Authorization: Bearer ' . $token],
        ]);
        $raw   = curl_exec($ch);
        $errno = curl_errno($ch);
        $cerr  = curl_error($ch);
        $http  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        v3_track_buc($respHeaders);
        if ($errno) {
            fail('NETWORK', 'Não consegui falar com a Meta (rede): ' . $cerr, 502,
                ['error_tipo' => 'cURL#' . $errno, 'error_origem' => 'metaGet(' . $path . ')']);
        }

        $j = json_decode($raw, true);
        if (!is_array($j)) {
            fail('BAD_RESPONSE', 'Resposta inesperada da Meta (HTTP ' . $http . ').', 502,
                ['error_tipo' => 'NonJSON', 'error_origem' => 'metaGet(' . $path . ')',
                 'error_detalhe' => mb_substr((string) $raw, 0, 300)]);
        }

        if (isset($j['error'])) {
            $m    = $j['error']['message'] ?? 'erro desconhecido';
            $code = (int)($j['error']['code'] ?? 0);
            if (in_array($code, [190, 102, 463, 467], true)) {
                fail('TOKEN', 'O token/App da Meta está inválido ou expirou (a Meta respondeu: "' . $m . '"). Gere um novo App + Usuário do Sistema + token — passo a passo no DEPLOY-V3.md.', 502,
                    ['error_tipo' => 'OAuthException#' . $code, 'error_origem' => 'metaGet(' . $path . ')']);
            }
            if (in_array($code, [10, 200, 272, 803], true)) {
                fail('PERMISSION', 'Sem permissão para ler esta conta. Confira se a parceria/atribuição da conta ao Usuário do Sistema está ativa.', 502);
            }
            if ($code === 17 || $code === 4 || $code === 80000) {
                fail('RATE_LIMIT', 'A Meta está limitando as consultas no momento. Espere alguns minutos e tente de novo (ou abra um relatório já salvo).', 429);
            }
            fail('META_API', 'Meta: ' . $m, 502,
                ['error_tipo' => 'MetaError#' . $code, 'error_origem' => 'metaGet(' . $path . ')']);
        }

        if (isset($j['data']) && is_array($j['data'])) $out = array_merge($out, $j['data']);
        $url = $j['paging']['next'] ?? null;
    }
    return $out;
}

/* Versão "soft" (best-effort): uma página só, devolve null em qualquer erro
   (não interrompe o relatório). Usada para os extras opcionais (foto, criativos). */
function metaGetSoft($path, array $params, $token) {
    $p   = ltrim($path, '/');   // path vazio (consulta por ?ids=) usa o nó raiz, sem barra extra
    $url = 'https://graph.facebook.com/' . META_API_VERSION . ($p === '' ? '' : '/' . $p) . '?' . http_build_query($params);
    if (!function_exists('curl_init')) return null;
    $ch = curl_init($url);
    $respHeaders = '';
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_HEADERFUNCTION => function ($c, $line) use (&$respHeaders) { $respHeaders .= $line; return strlen($line); },
        CURLOPT_NOSIGNAL => true, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1, CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $token],
    ]);
    $raw = curl_exec($ch); $errno = curl_errno($ch); curl_close($ch);
    v3_track_buc($respHeaders);
    if ($errno) return null;
    $j = json_decode($raw, true);
    if (!is_array($j) || isset($j['error'])) return null;
    return $j;
}

/* Baixa os bytes de uma imagem pública da CDN da Meta (sem token). Devolve
   ['b64','mime'] ou null. Limita o tamanho para não inchar o banco. */
function metaFetchBytes($url) {
    if (!function_exists('curl_init') || !is_string($url) || $url === '') return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 12, CURLOPT_CONNECTTIMEOUT => 8,
        CURLOPT_NOSIGNAL => true, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1, CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_FOLLOWLOCATION => true, CURLOPT_MAXREDIRS => 3,
    ]);
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $http  = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ct    = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    if ($errno || $http >= 400 || !is_string($raw) || $raw === '') return null;
    if (strlen($raw) > 2000000) return null;
    $mime = is_string($ct) ? trim(explode(';', $ct)[0]) : 'image/jpeg';
    if (strpos($mime, 'image/') !== 0) $mime = 'image/jpeg';
    $sz = @getimagesizefromstring($raw);   // largura/altura p/ validar qualidade
    return ['b64' => base64_encode($raw), 'mime' => $mime, 'w' => $sz ? (int) $sz[0] : 0, 'h' => $sz ? (int) $sz[1] : 0];
}

/* Recorta um "array de arrays" (linha 0 = cabeçalhos) pelos dias dentro de
   [since,until]. A coluna 11 é "Início dos relatórios" (date_start AAAA-MM-DD);
   como os relatórios são granulares por dia, isso produz um sub-período correto. */
function v3_slice_aoa(array $aoa, $since, $until) {
    if (count($aoa) < 1) return $aoa;
    $out = [$aoa[0]];
    for ($i = 1; $i < count($aoa); $i++) {
        $d = (string)($aoa[$i][11] ?? '');
        if ($d >= $since && $d <= $until) $out[] = $aoa[$i];
    }
    return $out;
}

/* Agrega um relatório em métricas-resumo para a análise de anomalias: totais,
   custo por resultado, anúncio nº1 (por resultado) e onde o algoritmo mais
   investiu (gênero/idade por gasto; plataforma por gasto). */
function v3_aggregate(array $payload): array {
    $main = $payload['main'] ?? [];
    $plat = (isset($payload['platform']) && is_array($payload['platform'])) ? $payload['platform'] : [];
    $results = 0.0; $spend = 0.0;
    $byAdRes = []; $bySpendGender = []; $bySpendAge = []; $bySpendPlat = [];
    for ($i = 1; $i < count($main); $i++) {
        $row = $main[$i];
        $res = (float)($row[5] ?? 0); $sp = (float)($row[7] ?? 0);
        $results += $res; $spend += $sp;
        $ad  = (string)($row[2] ?? ''); if ($ad  !== '') $byAdRes[$ad]        = ($byAdRes[$ad] ?? 0) + $res;
        $age = (string)($row[3] ?? ''); if ($age !== '') $bySpendAge[$age]    = ($bySpendAge[$age] ?? 0) + $sp;
        $gen = (string)($row[4] ?? ''); if ($gen !== '') $bySpendGender[$gen] = ($bySpendGender[$gen] ?? 0) + $sp;
    }
    for ($i = 1; $i < count($plat); $i++) { $p = (string)($plat[$i][3] ?? ''); if ($p !== '') $bySpendPlat[$p] = ($bySpendPlat[$p] ?? 0) + (float)($plat[$i][7] ?? 0); }
    arsort($byAdRes); arsort($bySpendGender); arsort($bySpendAge); arsort($bySpendPlat);
    return [
        'results'    => $results, 'spend' => $spend, 'cpr' => $results > 0 ? $spend / $results : 0,
        'top_ad'     => $byAdRes       ? (string) array_key_first($byAdRes)       : '',
        'top_gender' => $bySpendGender ? (string) array_key_first($bySpendGender) : '',
        'top_age'    => $bySpendAge    ? (string) array_key_first($bySpendAge)    : '',
        'top_plat'   => $bySpendPlat   ? (string) array_key_first($bySpendPlat)   : '',
    ];
}

/* Compara dois resumos (mês atual × anterior) e lista as anomalias. Numéricos:
   variação ≥25% (com piso para não disparar com números minúsculos). Categóricos:
   qualquer mudança do líder (anúncio nº1, gênero/idade/plataforma dominante). */
function v3_anomalies(array $cur, array $prev): array {
    $out = [];
    $pct = function ($c, $p) { return $p > 0 ? ($c - $p) / $p * 100 : ($c > 0 ? 100 : 0); };
    $TH = 25;
    if ($cur['results'] >= 5 || $prev['results'] >= 5) {
        $d = $pct($cur['results'], $prev['results']);
        if (abs($d) >= $TH) $out[] = ['tipo' => 'resultados', 'dir' => $d < 0 ? 'queda' : 'alta', 'pct' => (int) round($d), 'antes' => round($prev['results']), 'agora' => round($cur['results']), 'texto' => 'Resultados ' . ($d < 0 ? 'caíram' : 'subiram') . ' ' . abs((int) round($d)) . '%'];
    }
    if ($cur['spend'] >= 10 || $prev['spend'] >= 10) {
        $d = $pct($cur['spend'], $prev['spend']);
        if (abs($d) >= $TH) $out[] = ['tipo' => 'gasto', 'dir' => $d < 0 ? 'queda' : 'alta', 'pct' => (int) round($d), 'antes' => $prev['spend'], 'agora' => $cur['spend'], 'texto' => 'Investimento ' . ($d < 0 ? 'caiu' : 'subiu') . ' ' . abs((int) round($d)) . '%'];
    }
    if ($cur['cpr'] > 0 && $prev['cpr'] > 0) {
        $d = $pct($cur['cpr'], $prev['cpr']);
        if (abs($d) >= $TH) $out[] = ['tipo' => 'cpr', 'dir' => $d > 0 ? 'alta' : 'queda', 'pct' => (int) round($d), 'antes' => $prev['cpr'], 'agora' => $cur['cpr'], 'texto' => 'Custo por resultado ' . ($d > 0 ? 'subiu' : 'caiu') . ' ' . abs((int) round($d)) . '%'];
    }
    if ($cur['top_ad'] !== '' && $prev['top_ad'] !== '' && $cur['top_ad'] !== $prev['top_ad']) {
        $out[] = ['tipo' => 'top_ad', 'texto' => 'O anúncio nº1 em resultados mudou', 'antes' => $prev['top_ad'], 'agora' => $cur['top_ad']];
    }
    $g = ['male' => 'Masculino', 'female' => 'Feminino', 'unknown' => 'Desconhecido'];
    if ($cur['top_gender'] !== '' && $prev['top_gender'] !== '' && $cur['top_gender'] !== $prev['top_gender']) {
        $out[] = ['tipo' => 'genero', 'texto' => 'O gênero com mais investimento mudou', 'antes' => ($g[$prev['top_gender']] ?? $prev['top_gender']), 'agora' => ($g[$cur['top_gender']] ?? $cur['top_gender'])];
    }
    if ($cur['top_age'] !== '' && $prev['top_age'] !== '' && $cur['top_age'] !== $prev['top_age']) {
        $out[] = ['tipo' => 'idade', 'texto' => 'A faixa etária com mais investimento mudou', 'antes' => $prev['top_age'], 'agora' => $cur['top_age']];
    }
    if ($cur['top_plat'] !== '' && $prev['top_plat'] !== '' && $cur['top_plat'] !== $prev['top_plat']) {
        $out[] = ['tipo' => 'plataforma', 'texto' => 'A plataforma com mais investimento mudou', 'antes' => $prev['top_plat'], 'agora' => $cur['top_plat']];
    }
    return $out;
}

/* Busca a imagem só dos anúncios do TOP 5 (por conjunto E por campanha, por
   resultados) — os que aparecem na tela, não os ~35 que veicularam. Reusa o
   cache de criativos por perfil; só salva no banco em boa resolução. Usada tanto
   no relatório ao vivo quanto ao servir do cache (que tem `ad_ids` no meta).
   $adIds = nome→ad_id. Preenche $thumbsMeta por referência. */
function v3_fetch_top_creatives(array $main, array $adIds, $account, $token, $refresh, $hasStore, array &$thumbsMeta) {
    $resByCampAd = []; $resByAdsetAd = [];
    for ($i = 1; $i < count($main); $i++) {
        $row = $main[$i];
        $resByCampAd[$row[0]][$row[2]]  = ($resByCampAd[$row[0]][$row[2]] ?? 0) + (float) $row[5];
        $resByAdsetAd[$row[1]][$row[2]] = ($resByAdsetAd[$row[1]][$row[2]] ?? 0) + (float) $row[5];
    }
    $top = [];
    foreach ([$resByCampAd, $resByAdsetAd] as $grp) {
        foreach ($grp as $ads) { arsort($ads); $k = 0; foreach ($ads as $n => $r) { if ($k++ >= 5) break; if ($n !== '') $top[$n] = true; } }
    }
    $names = array_keys($top);
    if (!$names) return [];

    $thumbs = (!$refresh && $hasStore) ? V3Store::getCreatives($account, $names, V3_CALC) : [];
    $thumbsMeta['cached'] = count($thumbs);
    $missing = (!$refresh && $hasStore) ? V3Store::missingCreativeNames($account, $names, V3_CALC) : array_values(array_unique($names));
    $missingIds = [];
    foreach ($missing as $name) { $id = (string)($adIds[$name] ?? ''); if ($id !== '') $missingIds[$id] = $name; }
    if ($missingIds) {
        v3_step('meta:creatives');
        $urlById = metaFetchCreativesByIds(array_keys($missingIds), $token);
        foreach ($missingIds as $id => $name) {
            $url = $urlById[$id] ?? '';
            if ($url === '') { $thumbsMeta['failed']++; continue; }
            if ($hasStore) {
                $b = metaFetchBytes($url);
                if ($b) {
                    if ($b['w'] >= V3_MIN_GOOD_PX) {
                        V3Store::setCreative($account, $name, $b['b64'], $b['mime'], V3_CALC);
                    } else {
                        $thumbsMeta['low_quality']++;
                        if (count($thumbsMeta['low_quality_names']) < 30) $thumbsMeta['low_quality_names'][] = $name;
                    }
                    $thumbs[$name] = 'data:' . $b['mime'] . ';base64,' . $b['b64'];
                } else { $thumbs[$name] = $url; $thumbsMeta['failed']++; }
            } else { $thumbs[$name] = $url; }
            $thumbsMeta['fetched']++;
        }
    }
    return $thumbs;
}

/* Busca os criativos de anúncios ESPECÍFICOS (por id, em lotes), em ALTA
   resolução. Para imagem: image_url (original). Para vídeo: a capa oficial em
   object_story_spec.video_data.image_url quando existe; senão, o thumbnail do
   CRIATIVO pedido em 1080px (o nó de vídeo é barrado pelo token ads_read).
   Só os anúncios que veicularam no período. Devolve [ad_id => url], best-effort. */
function metaFetchCreativesByIds(array $ids, $token) {
    $out     = [];   // ad_id => melhor url de imagem
    $needHi  = [];   // ad_id => creative_id (precisa do thumbnail em alta)
    foreach (array_chunk(array_values(array_unique($ids)), 50) as $chunk) {
        $j = metaGetSoft('', [
            'ids'    => implode(',', $chunk),
            'fields' => 'creative{id,image_url,thumbnail_url,video_id,object_story_spec{video_data{image_url}}}',
        ], $token);
        if (!is_array($j)) continue;
        foreach ($j as $id => $ad) {
            if (!is_array($ad)) continue;
            $cr     = $ad['creative'] ?? [];
            $ossImg = $cr['object_story_spec']['video_data']['image_url'] ?? '';
            if (!empty($cr['image_url'])) {
                $out[(string) $id] = $cr['image_url'];          // imagem estática original (alta)
            } elseif ($ossImg !== '') {
                $out[(string) $id] = $ossImg;                   // capa oficial do vídeo (alta)
            } elseif (!empty($cr['id'])) {
                $needHi[(string) $id] = (string) $cr['id'];     // busca o thumbnail do criativo em alta
                if (!empty($cr['thumbnail_url'])) $out[(string) $id] = $cr['thumbnail_url']; // reserva (64px)
            } elseif (!empty($cr['thumbnail_url'])) {
                $out[(string) $id] = $cr['thumbnail_url'];
            }
        }
    }
    if ($needHi) {
        $hi = metaFetchHiResThumbs(array_values(array_unique($needHi)), $token);   // creative_id => url
        foreach ($needHi as $adId => $crId) {
            if (!empty($hi[$crId])) $out[$adId] = $hi[$crId];   // troca o 64px pelo thumbnail em alta
        }
    }
    return $out;
}

/* Thumbnail do CRIATIVO em alta resolução (1080px), por creative_id em lote.
   thumbnail_width/height aplicados ao NÓ do criativo (não ao aninhado) sobem a
   resolução tanto para imagem quanto para vídeo. Devolve [creative_id => url]. */
function metaFetchHiResThumbs(array $creativeIds, $token) {
    $out = [];
    foreach (array_chunk($creativeIds, 50) as $chunk) {
        $j = metaGetSoft('', [
            'ids'              => implode(',', $chunk),
            'fields'           => 'thumbnail_url',
            'thumbnail_width'  => 1080,
            'thumbnail_height' => 1080,
        ], $token);
        if (!is_array($j)) continue;
        foreach ($j as $crId => $c) {
            if (is_array($c) && !empty($c['thumbnail_url'])) $out[(string) $crId] = $c['thumbnail_url'];
        }
    }
    return $out;
}

/* Campos comuns às duas consultas. `optimization_goal` (a meta do conjunto) é o
   que a Meta usa para definir o "Resultado" — mais confiável que o objetivo. */
$fields = 'campaign_name,adset_name,ad_name,ad_id,objective,optimization_goal,spend,impressions,reach,inline_link_clicks,actions';
$timeRange = json_encode(['since' => $since, 'until' => $until]);

$commonParams = [
    'level'          => 'ad',
    'time_range'     => $timeRange,
    'time_increment' => 1,        // série diária (a V2 usa para o gráfico de linha)
    'fields'         => $fields,
    'limit'          => 500,
];

/* Consulta A: idade × gênero (relatório "principal"). */
$mainParams = $commonParams;
$mainParams['breakdowns'] = 'age,gender';
$mainRows = metaGet('act_' . $accountId . '/insights', $mainParams, $activeToken);

/* Consulta B: plataforma × posicionamento (não pode coexistir com idade/gênero). */
$platParams = $commonParams;
$platParams['breakdowns'] = 'publisher_platform,platform_position';
$platRows = metaGet('act_' . $accountId . '/insights', $platParams, $activeToken);

if (!$mainRows && !$platRows) {
    if ($V3_HAS_STORE) V3Store::logCall($usuario, $accountId, 'report', v3_ms(), 404, $GLOBALS['v3_buc'], false);
    fail('NO_DATA', 'Não há dados para essa conta neste período (ou as campanhas não veicularam).', 404);
}

/* ── 9) Mapeamento de "Resultados" ────────────────────────────────────────
   A Meta define o "Resultado" pela META DE OTIMIZAÇÃO do conjunto
   (optimization_goal), não só pelo objetivo da campanha — por isso um objetivo
   guarda-chuva como OUTCOME_ENGAGEMENT pode render mensagem, engajamento OU
   vídeo. Priorizamos optimization_goal; o objetivo é só reserva. Use ?debug=1
   para ver os tipos de ação e as metas de otimização realmente presentes. */
$RESULT_BY_OPT_GOAL = [
    // Mensagem (WhatsApp/Messenger/Instagram): o "Resultado" da Meta é "Conversas
    // por mensagem iniciadas". As campanhas de mensagem usam a meta REPLIES (não
    // CONVERSATIONS) — verificado ao vivo (Costa & Xavier 002: REPLIES → 129,
    // batendo com o painel). Ação ÚNICA para não inflar com conexões/respostas.
    'REPLIES'                          => ['onsite_conversion.messaging_conversation_started_7d'],
    'CONVERSATIONS'                    => ['onsite_conversion.messaging_conversation_started_7d'],
    'MESSAGING_PURCHASE_CONVERSION'    => ['onsite_conversion.messaging_conversation_started_7d'],
    'MESSAGING_APPOINTMENT_CONVERSION' => ['onsite_conversion.messaging_conversation_started_7d'],
    'LEAD_GENERATION'     => ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'],
    'QUALITY_LEAD'        => ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'],
    'LINK_CLICKS'         => ['link_click'],
    'LANDING_PAGE_VIEWS'  => ['landing_page_view'],
    // Conversão (cadastro/compra/lead/personalizada). O evento real varia por
    // cliente — Erica usa uma CONVERSÃO PERSONALIZADA (offsite_conversion.custom.*),
    // não compra. Curinga `*` no fim soma todas as ações com aquele prefixo.
    'OFFSITE_CONVERSIONS' => ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_purchase', 'purchase', 'onsite_conversion.purchase', 'offsite_conversion.custom.*'],
    'CONVERSIONS'         => ['offsite_conversion.fb_pixel_complete_registration', 'complete_registration', 'offsite_conversion.fb_pixel_lead', 'onsite_conversion.lead_grouped', 'lead', 'offsite_conversion.fb_pixel_purchase', 'purchase', 'onsite_conversion.purchase', 'offsite_conversion.custom.*'],
    'POST_ENGAGEMENT'     => ['post_engagement'],
    'ENGAGED_USERS'       => ['post_engagement'],
    'EVENT_RESPONSES'     => ['rsvp', 'event_responses'],
    'PAGE_LIKES'          => ['onsite_conversion.post_net_like', 'like'],
    'THRUPLAY'            => ['video_thruplay_watched_actions', 'video_view'],
    'VIDEO_VIEWS'         => ['video_view'],
    'TWO_SECOND_CONTINUOUS_VIDEO_VIEWS' => ['video_view'],
    'QUALITY_CALL'            => ['onsite_conversion.click_to_call', 'click_to_call'],
    'MEANINGFUL_CALL_ATTEMPT' => ['onsite_conversion.click_to_call', 'click_to_call'],
    // Visitas ao perfil (Instagram). A Meta varia o nome da ação por conta/objetivo
    // — por isso o curinga `*profile_visit*` no fim, que casa qualquer variante
    // (ig_profile_visit, ig_business_profile_visit, etc.) caso os nomes exatos não
    // apareçam. Sem ele, a meta era reconhecida mas o resultado vinha 0 (Sabadin).
    'PROFILE_VISIT'           => ['onsite_conversion.ig_profile_visit', 'profile_visit', '*profile_visit*'],
    'VISIT_INSTAGRAM_PROFILE' => ['onsite_conversion.ig_profile_visit', 'profile_visit', '*profile_visit*'],
    'PROFILE_AND_PAGE_ENGAGEMENT' => ['onsite_conversion.ig_profile_visit', 'profile_visit', '*profile_visit*'],
    'REACH'               => [],   // resultado = alcance (sem action_type)
    'IMPRESSIONS'         => [],
];
$RESULT_BY_OBJECTIVE = [
    'OUTCOME_ENGAGEMENT'    => ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection', 'onsite_conversion.messaging_first_reply', 'post_engagement'],
    'MESSAGES'              => ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection'],
    'OUTCOME_TRAFFIC'       => ['link_click', 'landing_page_view'],
    'LINK_CLICKS'           => ['link_click'],
    'OUTCOME_LEADS'         => ['onsite_conversion.lead_grouped', 'leadgen_grouped', 'lead'],
    'LEAD_GENERATION'       => ['leadgen_grouped', 'lead'],
    'OUTCOME_SALES'         => ['offsite_conversion.fb_pixel_purchase', 'purchase', 'onsite_conversion.purchase'],
    'CONVERSIONS'           => ['offsite_conversion.fb_pixel_purchase', 'purchase'],
    'PRODUCT_CATALOG_SALES' => ['offsite_conversion.fb_pixel_purchase', 'purchase'],
];
/* Usado quando o objetivo não está no mapa ou não houve a ação esperada. */
$RESULT_FALLBACK = ['onsite_conversion.messaging_conversation_started_7d', 'onsite_conversion.total_messaging_connection', 'link_click', 'landing_page_view', 'lead', 'purchase'];
/* Rótulo amigável → vira a coluna "Tipo de resultado". */
$ACTION_LABELS = [
    'onsite_conversion.messaging_conversation_started_7d' => 'Conversas iniciadas',
    'onsite_conversion.total_messaging_connection'        => 'Conversas iniciadas',
    'onsite_conversion.messaging_first_reply'             => 'Conversas iniciadas',
    'link_click'                                          => 'Cliques no link',
    'landing_page_view'                                   => 'Visualizações da página',
    'onsite_conversion.lead_grouped'                      => 'Cadastros',
    'leadgen_grouped'                                     => 'Cadastros',
    'lead'                                                => 'Cadastros',
    'offsite_conversion.fb_pixel_purchase'                => 'Compras',
    'purchase'                                            => 'Compras',
    'offsite_conversion.fb_pixel_complete_registration'   => 'Cadastros',
    'complete_registration'                               => 'Cadastros',
    'offsite_conversion.fb_pixel_lead'                    => 'Cadastros',
    'offsite_conversion.custom.*'                         => 'Conversões',
    'post_engagement'                                     => 'Engajamentos',
    'video_thruplay_watched_actions'                      => 'ThruPlays',
    'video_view'                                          => 'Visualizações de vídeo',
    'onsite_conversion.post_net_like'                     => 'Curtidas',
    'like'                                                => 'Curtidas',
    'onsite_conversion.click_to_call'                     => 'Ligações',
    'click_to_call'                                       => 'Ligações',
    'rsvp'                                                => 'Respostas ao evento',
    'event_responses'                                     => 'Respostas ao evento',
    'onsite_conversion.ig_profile_visit'                  => 'Visitas ao perfil',
    'profile_visit'                                       => 'Visitas ao perfil',
    '*profile_visit*'                                     => 'Visitas ao perfil',
];

/** Percorre uma lista de candidatos e devolve [valor, rótulo] do primeiro que
    existir nas ações. Curingas com `*`:
      `prefixo*`  → soma toda ação que COMEÇA com o prefixo (ex.: conversões
                    personalizadas `offsite_conversion.custom.*`);
      `*trecho*`  → soma toda ação que CONTÉM o trecho — usado quando a Meta varia
                    o nome (ex.: `*profile_visit*` cobre `ig_profile_visit`,
                    `ig_business_profile_visit`, `profile_visit`).
    Os candidatos exatos vêm primeiro na lista, então o curinga só age se nenhum
    nome exato casar (sem dupla contagem). Devolve null se nenhum casar. */
function pickFromList(array $cands, array $actions, array $labels) {
    foreach ($cands as $t) {
        $lead  = ($t !== '' && $t[0] === '*');
        $trail = (substr($t, -1) === '*');
        if ($lead && $trail && strlen($t) > 2) {
            $needle = substr($t, 1, -1);
            $sum = 0; $found = false;
            foreach ($actions as $at => $av) { if (strpos($at, $needle) !== false) { $sum += $av; $found = true; } }
            if ($found) return [$sum, $labels[$t] ?? 'Conversões'];
        } elseif ($trail) {
            $prefix = substr($t, 0, -1);
            $sum = 0; $found = false;
            foreach ($actions as $at => $av) { if (strncmp($at, $prefix, strlen($prefix)) === 0) { $sum += $av; $found = true; } }
            if ($found) return [$sum, $labels[$t] ?? 'Conversões'];
        } elseif (isset($actions[$t])) {
            return [$actions[$t], $labels[$t] ?? $t];
        }
    }
    return null;
}

/** Extrai o "Resultado" (valor) e seu rótulo de uma linha de insights.
    Prioridade: meta de otimização do conjunto → objetivo da campanha → reserva. */
function pickResult(array $row, array $byGoal, array $byObj, array $fallback, array $labels) {
    $actions = [];
    foreach (($row['actions'] ?? []) as $a) {
        if (isset($a['action_type'])) $actions[$a['action_type']] = (float)($a['value'] ?? 0);
    }
    // 1) Pela meta de otimização — é exatamente o que a Meta usa no "Resultado".
    $goal = strtoupper((string)($row['optimization_goal'] ?? ''));
    if (array_key_exists($goal, $byGoal)) {
        if ($goal === 'REACH' || $goal === 'IMPRESSIONS') return [(float)($row['reach'] ?? 0), 'Alcance'];
        $r = pickFromList($byGoal[$goal], $actions, $labels);
        if ($r !== null) return $r;
        // Meta conhecida, mas sem a ação NESTA linha → 0 (não inflar com engajamento).
        return [0, isset($byGoal[$goal][0]) ? ($labels[$byGoal[$goal][0]] ?? '') : ''];
    }
    // 2) Reserva pelo objetivo da campanha. 3) Reserva genérica.
    $obj = strtoupper((string)($row['objective'] ?? ''));
    $r = pickFromList($byObj[$obj] ?? $fallback, $actions, $labels);
    if ($r !== null) return $r;
    $r = pickFromList($fallback, $actions, $labels);
    if ($r !== null) return $r;
    return [0, ''];
}

/* Depuração ?debug=1: tipos de ação + metas de otimização presentes (p/ mapear). */
if ($debug === '1') {
    $seen = []; $goals = [];
    foreach (array_merge($mainRows, $platRows) as $r) {
        $g = $r['optimization_goal'] ?? '(vazio)';
        $goals[$g] = ($goals[$g] ?? 0) + 1;
        foreach (($r['actions'] ?? []) as $a) {
            $t = $a['action_type'] ?? '';
            if ($t !== '') $seen[$t] = ($seen[$t] ?? 0) + (float)($a['value'] ?? 0);
        }
    }
    arsort($seen); arsort($goals);
    echo json_encode(['ok' => true, 'debug' => true, 'action_types' => $seen, 'optimization_goals' => $goals, 'rows_main' => count($mainRows), 'rows_platform' => count($platRows)], JSON_UNESCAPED_UNICODE);
    exit;
}

/* Depuração ?debug=cr: criativos crus dos primeiros anúncios do período — para
   inspecionar como o vídeo é referenciado (creative.video_id, object_story_spec,
   asset_feed_spec) e validar a qualidade da imagem. */
if ($debug === 'cr') {
    $ids = [];
    foreach ($mainRows as $r) { $id = (string)($r['ad_id'] ?? ''); if ($id !== '' && !in_array($id, $ids, true)) { $ids[] = $id; if (count($ids) >= 8) break; } }
    $raw = $ids ? metaGetSoft('', [
        'ids'              => implode(',', $ids),
        'fields'           => 'name,creative{id,image_url,thumbnail_url,video_id,object_type,object_story_spec{video_data{video_id,image_url}},asset_feed_spec}',
        'thumbnail_width'  => 600,
        'thumbnail_height' => 600,
    ], $activeToken) : [];
    echo json_encode(['ok' => true, 'debug_creatives' => $raw], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

/* Depuração ?debug=vt: para os primeiros anúncios, BAIXA cada fonte de imagem no
   servidor e mede os pixels reais (getimagesize) — diz qual entrega alta. */
if ($debug === 'vt') {
    $ids = [];
    foreach ($mainRows as $r) { $id = (string)($r['ad_id'] ?? ''); if ($id !== '' && !in_array($id, $ids, true)) { $ids[] = $id; if (count($ids) >= 5) break; } }
    $j = $ids ? metaGetSoft('', ['ids' => implode(',', $ids), 'fields' => 'creative{id,image_url,thumbnail_url,video_id,object_story_spec{video_data{image_url}}}'], $activeToken) : [];
    $dim = function ($url) {
        if (!is_string($url) || $url === '') return '-';
        $b = metaFetchBytes($url);
        if (!$b) return 'download_fail';
        $s = @getimagesizefromstring(base64_decode($b['b64']));
        return $s ? ($s[0] . 'x' . $s[1]) : 'no_size';
    };
    $report = [];
    foreach (($j ?: []) as $id => $ad) {
        $cr   = $ad['creative'] ?? [];
        $crId = (string)($cr['id'] ?? '');
        $hi   = '';
        if ($crId !== '') {
            $h  = metaGetSoft('', ['ids' => $crId, 'fields' => 'thumbnail_url', 'thumbnail_width' => 1080, 'thumbnail_height' => 1080], $activeToken);
            $hi = $h[$crId]['thumbnail_url'] ?? '';
        }
        $report[] = [
            'ad'                 => (string) $id,
            'is_video'           => !empty($cr['video_id']),
            'image_url'          => $dim($cr['image_url'] ?? ''),
            'oss_video_image'    => $dim($cr['object_story_spec']['video_data']['image_url'] ?? ''),
            'creative_thumb_pad' => $dim($cr['thumbnail_url'] ?? ''),
            'creative_thumb_1080'=> $dim($hi),
        ];
    }
    echo json_encode(['ok' => true, 'sources' => $report], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

/* ── 10) Monta as planilhas no formato do Excel (linha 0 = cabeçalhos) ─────
   Os títulos batem com os aliases que o resolveColumns (report-parser.js) usa. */
$HEAD_MAIN = ['Nome da campanha', 'Nome do conjunto de anúncios', 'Nome do anúncio', 'Idade', 'Gênero', 'Resultados', 'Tipo de resultado', 'Valor usado (BRL)', 'Impressões', 'Alcance', 'Cliques no link', 'Início dos relatórios'];
$HEAD_PLAT = ['Nome da campanha', 'Nome do conjunto de anúncios', 'Nome do anúncio', 'Plataforma', 'Posicionamento', 'Resultados', 'Tipo de resultado', 'Valor usado (BRL)', 'Impressões', 'Alcance', 'Cliques no link', 'Início dos relatórios'];

$main = [$HEAD_MAIN];
$adIdByName = [];   // nome do anúncio → ad_id (primeiro visto), p/ buscar só os criativos que rodaram
$namesInReport = [];
foreach ($mainRows as $r) {
    [$res, $rtype] = pickResult($r, $RESULT_BY_OPT_GOAL, $RESULT_BY_OBJECTIVE, $RESULT_FALLBACK, $ACTION_LABELS);
    $adName = (string)($r['ad_name'] ?? '');
    if ($adName !== '' && !isset($adIdByName[$adName])) {
        $adIdByName[$adName] = (string)($r['ad_id'] ?? '');
        $namesInReport[]     = $adName;
    }
    $main[] = [
        $r['campaign_name'] ?? '', $r['adset_name'] ?? '', $adName,
        $r['age'] ?? '', $r['gender'] ?? '',
        $res, $rtype,
        (float)($r['spend'] ?? 0), (int)($r['impressions'] ?? 0), (int)($r['reach'] ?? 0),
        (int)($r['inline_link_clicks'] ?? 0), $r['date_start'] ?? '',
    ];
}

$platform = [$HEAD_PLAT];
foreach ($platRows as $r) {
    [$res, $rtype] = pickResult($r, $RESULT_BY_OPT_GOAL, $RESULT_BY_OBJECTIVE, $RESULT_FALLBACK, $ACTION_LABELS);
    $platform[] = [
        $r['campaign_name'] ?? '', $r['adset_name'] ?? '', $r['ad_name'] ?? '',
        $r['publisher_platform'] ?? '', $r['platform_position'] ?? '',
        $res, $rtype,
        (float)($r['spend'] ?? 0), (int)($r['impressions'] ?? 0), (int)($r['reach'] ?? 0),
        (int)($r['inline_link_clicks'] ?? 0), $r['date_start'] ?? '',
    ];
}

/* Depuração ?debug=2: comparação principal × plataforma (origem de discrepâncias
   tipo "resultados diferem X%"), objetivos vistos e amostras das linhas cruas. */
if ($debug === '2') {
    $objMain = []; foreach ($mainRows as $r) { $objMain[$r['objective'] ?? '(vazio)'] = true; }
    $objPlat = []; foreach ($platRows as $r) { $objPlat[$r['objective'] ?? '(vazio)'] = true; }
    $byCamp = [];
    $acc = function (&$bc, $c) { if (!isset($bc[$c])) $bc[$c] = ['resMain' => 0, 'resPlat' => 0, 'spendMain' => 0, 'spendPlat' => 0]; };
    for ($i = 1; $i < count($main); $i++)     { $c = $main[$i][0];     $acc($byCamp, $c); $byCamp[$c]['resMain']  += (float)$main[$i][5];     $byCamp[$c]['spendMain']  += (float)$main[$i][7]; }
    for ($i = 1; $i < count($platform); $i++) { $c = $platform[$i][0]; $acc($byCamp, $c); $byCamp[$c]['resPlat']  += (float)$platform[$i][5]; $byCamp[$c]['spendPlat']  += (float)$platform[$i][7]; }
    $tot = function ($aoa) { $r = 0; $s = 0; for ($i = 1; $i < count($aoa); $i++) { $r += (float)$aoa[$i][5]; $s += (float)$aoa[$i][7]; } return ['results' => $r, 'spend' => $s, 'rows' => count($aoa) - 1]; };
    echo json_encode([
        'ok' => true, 'debug_compare' => true,
        'account' => $accountId, 'month' => $month,
        'objetivos_principal'  => array_keys($objMain),
        'objetivos_plataforma' => array_keys($objPlat),
        'totais' => ['principal' => $tot($main), 'plataforma' => $tot($platform)],
        'por_campanha' => $byCamp,
        'amostra_principal'  => array_slice($mainRows, 0, 8),
        'amostra_plataforma' => array_slice($platRows, 0, 8),
    ], JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit;
}

/* ── 11) Extras (melhor-esforço; falha NÃO interrompe o relatório) ─────────
   Foto/nome do cliente e thumbs dos criativos. As thumbs são buscadas só para
   os anúncios que veicularam (por ad_id), com dedup por nome e reuso do cache
   por perfil; quando há banco, os bytes são salvos para não repuxar nem
   depender de URL da CDN (que expira). */
$thumbsMeta = ['cached' => 0, 'fetched' => 0, 'failed' => 0, 'low_quality' => 0, 'low_quality_names' => []];
$thumbs = [];
$photo = null; $photoSource = null; $pageName = null;

/* No PREFETCH (backfill de histórico em background) só guardamos dados — sem
   criativos nem foto. No modo normal, busca a imagem do TOP 5 e a foto. */
if (!$prefetch) {
    $thumbs = v3_fetch_top_creatives($main, $adIdByName, $accountId, $activeToken, $refresh, $V3_HAS_STORE, $thumbsMeta);

    $photo = (!$refresh && $V3_HAS_STORE) ? V3Store::getProfilePhoto($accountId, $bmLabel) : null;
    $photoSource = $photo ? 'profile' : null;
    $pg = metaGetSoft('act_' . $accountId . '/promote_pages', ['fields' => 'name,picture.width(320).height(320)', 'limit' => 1], $activeToken);
    if ($pg && !empty($pg['data'][0])) {
        $p0 = $pg['data'][0];
        $pageName = $p0['name'] ?? null;
        if (!$photo && !empty($p0['picture']['data']['url'])) {
            $purl = $p0['picture']['data']['url'];
            if ($V3_HAS_STORE) {
                $b = metaFetchBytes($purl);
                if ($b) {
                    V3Store::setProfilePhoto($accountId, $bmLabel, ($clientLabel ?: ($pageName ?: '')), $b['b64'], $b['mime'], 'auto');
                    $photo = 'data:' . $b['mime'] . ';base64,' . $b['b64'];
                    $photoSource = 'auto';
                } else { $photo = $purl; $photoSource = 'auto'; }
            } else { $photo = $purl; $photoSource = 'auto'; }
        }
    }
}

$extras = [
    'photo'        => $photo,
    'photo_source' => $photoSource,
    'pageName'     => $pageName,
    'thumbs'       => $thumbs ?: (object) [],
];

$payload = [
    'ok'       => true,
    'main'     => $main,
    'platform' => count($platform) > 1 ? $platform : null,
    'extras'   => $extras,
    'meta'     => [
        'account'       => $accountId,
        'bm'            => $bmLabel,
        'month'         => $month,
        'since'         => $since,
        'until'         => $until,
        'rows_main'     => count($main) - 1,
        'rows_platform' => count($platform) - 1,
        'thumbs'        => $thumbsMeta,
        'from_cache'    => false,
        'calc'          => V3_CALC,
        'ad_ids'        => $adIdByName,   // nome→ad_id, p/ buscar criativos a partir do cache
    ],
];

if ($V3_HAS_STORE) {
    V3Store::setReport($accountId, $since, $until, $payload, $isFinal);
    V3Store::logCall($usuario, $accountId, 'report', v3_ms(), 200, $GLOBALS['v3_buc'], false);
}

$payload['origin'] = 'live';
$payload['usage']  = $V3_HAS_STORE ? V3Store::usageToday() : null;
echo json_encode($payload, JSON_UNESCAPED_UNICODE);
