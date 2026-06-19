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
 *   - Stateless: nada é gravado em disco/banco; cada relatório é uma consulta nova.
 *   - Suporta várias BMs (META_TOKENS): um token por BM, escolhido conforme a conta.
 *
 * Resposta de sucesso: { ok:true, main:[[...]], platform:[[...]], meta:{...} }
 *   onde main/platform são "array de arrays" (linha 0 = cabeçalhos).
 * Resposta de erro:    { ok:false, error:"mensagem em PT", code:"COD" } + HTTP.
 */

header('Content-Type: application/json; charset=utf-8');

/* Carimbo de versão do backend. BATA ESTE VALOR com o V3_BUILD do
   js/meta-api-v3.js a cada release: a tela do V3 mostra os dois lado a lado e
   avisa se divergirem — é assim que se confirma que o deploy realmente subiu. */
define('V3_BUILD', 'v3.5 · 2026-06-18');

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
function v3_step($s) { $GLOBALS['v3_step'] = $s; }
function v3_ms() { return (int) round((microtime(true) - ($GLOBALS['v3_t0'] ?? microtime(true))) * 1000); }

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
$accountId = preg_replace('/[^0-9]/', '', (string)($body['account'] ?? ''));
$month     = trim((string)($body['month'] ?? ''));   // formato AAAA-MM
$debug     = (string)($body['debug'] ?? '');          // '1' = tipos de ação · '2' = comparação

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
    // Sem conta escolhida → devolve a lista para o seletor. Em modo automático
    // (META_ACCOUNTS vazio), busca as contas de CADA BM via /me/adaccounts e
    // junta tudo; cada conta leva o índice 't' da BM e o rótulo 'bm'.
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
    echo json_encode(['ok' => true, 'build' => V3_BUILD, 'ms' => v3_ms(), 'accounts' => $list, 'auto' => !$curated, 'multi' => count($tokens) > 1, 'csrf' => $_SESSION['csrf']], JSON_UNESCAPED_UNICODE);
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
// Allowlist: havendo lista manual, a conta precisa estar nela. Sem lista manual
// (modo automático), confiamos nos tokens — a Meta recusa contas fora da BM.
if ($curated) {
    $allowed = false;
    foreach ($normAccts as $a) { if ($a['act_id'] === $accountId) { $allowed = true; break; } }
    if (!$allowed) fail('ACCOUNT_NOT_ALLOWED', 'Essa conta não está na lista META_ACCOUNTS. Apague a lista para liberar todas as contas dos tokens, ou inclua esta conta.', 403);
}

/* ── 7) Período já resolvido acima ($since / $until) ───────────────────── */

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
   O token vai no header Authorization (não na URL, para não vazar em logs). */
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
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
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
                fail('RATE_LIMIT', 'A Meta está limitando as consultas no momento. Espere alguns minutos e tente de novo.', 429);
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
   (não interrompe o relatório). Usada para os extras opcionais (foto, thumbs). */
function metaGetSoft($path, array $params, $token) {
    $url = 'https://graph.facebook.com/' . META_API_VERSION . '/' . ltrim($path, '/') . '?' . http_build_query($params);
    if (!function_exists('curl_init')) return null;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 30, CURLOPT_CONNECTTIMEOUT => 15,
        CURLOPT_NOSIGNAL => true, CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1, CURLOPT_IPRESOLVE => CURL_IPRESOLVE_V4,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'Authorization: Bearer ' . $token],
    ]);
    $raw = curl_exec($ch); $errno = curl_errno($ch); curl_close($ch);
    if ($errno) return null;
    $j = json_decode($raw, true);
    if (!is_array($j) || isset($j['error'])) return null;
    return $j;
}

/* Campos comuns às duas consultas. */
$fields = 'campaign_name,adset_name,ad_name,objective,spend,impressions,reach,inline_link_clicks,actions';
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
    fail('NO_DATA', 'Não há dados para essa conta neste mês (ou as campanhas não veicularam no período).', 404);
}

/* ── 9) Mapeamento de "Resultados" por objetivo da campanha ───────────────
   O array `actions` da API traz várias métricas; o "Resultado" do relatório
   depende do objetivo. AJUSTE AQUI se algum cliente usar outro objetivo —
   chame com ?debug=1 para ver os tipos de ação realmente presentes. */
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
    'post_engagement'                                     => 'Engajamentos',
];

/** Extrai o "Resultado" (valor) e seu rótulo de uma linha de insights. */
function pickResult(array $row, array $byObj, array $fallback, array $labels) {
    $actions = [];
    foreach (($row['actions'] ?? []) as $a) {
        if (isset($a['action_type'])) $actions[$a['action_type']] = (float)($a['value'] ?? 0);
    }
    $obj = strtoupper((string)($row['objective'] ?? ''));
    $candidates = $byObj[$obj] ?? $fallback;
    foreach ($candidates as $t) if (isset($actions[$t])) return [$actions[$t], $labels[$t] ?? $t];
    foreach ($fallback as $t) if (isset($actions[$t])) return [$actions[$t], $labels[$t] ?? $t];
    return [0, ''];
}

/* Depuração ?debug=1: lista os tipos de ação presentes, para ajudar a mapear. */
if ($debug === '1') {
    $seen = [];
    foreach (array_merge($mainRows, $platRows) as $r) {
        foreach (($r['actions'] ?? []) as $a) {
            $t = $a['action_type'] ?? '';
            if ($t !== '') $seen[$t] = ($seen[$t] ?? 0) + (float)($a['value'] ?? 0);
        }
    }
    arsort($seen);
    echo json_encode(['ok' => true, 'debug' => true, 'action_types' => $seen, 'rows_main' => count($mainRows), 'rows_platform' => count($platRows)], JSON_UNESCAPED_UNICODE);
    exit;
}

/* ── 10) Monta as planilhas no formato do Excel (linha 0 = cabeçalhos) ─────
   Os títulos batem com os aliases que o resolveColumns (report-parser.js) usa. */
$HEAD_MAIN = ['Nome da campanha', 'Nome do conjunto de anúncios', 'Nome do anúncio', 'Idade', 'Gênero', 'Resultados', 'Tipo de resultado', 'Valor usado (BRL)', 'Impressões', 'Alcance', 'Cliques no link', 'Início dos relatórios'];
$HEAD_PLAT = ['Nome da campanha', 'Nome do conjunto de anúncios', 'Nome do anúncio', 'Plataforma', 'Posicionamento', 'Resultados', 'Tipo de resultado', 'Valor usado (BRL)', 'Impressões', 'Alcance', 'Cliques no link', 'Início dos relatórios'];

$main = [$HEAD_MAIN];
foreach ($mainRows as $r) {
    [$res, $rtype] = pickResult($r, $RESULT_BY_OBJECTIVE, $RESULT_FALLBACK, $ACTION_LABELS);
    $main[] = [
        $r['campaign_name'] ?? '', $r['adset_name'] ?? '', $r['ad_name'] ?? '',
        $r['age'] ?? '', $r['gender'] ?? '',
        $res, $rtype,
        (float)($r['spend'] ?? 0), (int)($r['impressions'] ?? 0), (int)($r['reach'] ?? 0),
        (int)($r['inline_link_clicks'] ?? 0), $r['date_start'] ?? '',
    ];
}

$platform = [$HEAD_PLAT];
foreach ($platRows as $r) {
    [$res, $rtype] = pickResult($r, $RESULT_BY_OBJECTIVE, $RESULT_FALLBACK, $ACTION_LABELS);
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
   Foto/nome do cliente (#6/#7) e thumbs dos criativos (#5). São URLs públicas
   da CDN da Meta — exibem sem o token e sem baixar/embutir nada. */
$extras = ['photo' => null, 'pageName' => null, 'thumbs' => (object) []];
$pg = metaGetSoft('act_' . $accountId . '/promote_pages', ['fields' => 'name,picture.width(160).height(160)', 'limit' => 1], $activeToken);
if ($pg && !empty($pg['data'][0])) {
    $p0 = $pg['data'][0];
    $extras['pageName'] = $p0['name'] ?? null;
    if (!empty($p0['picture']['data']['url'])) $extras['photo'] = $p0['picture']['data']['url'];
}
$ads = metaGetSoft('act_' . $accountId . '/ads', ['fields' => 'name,creative{thumbnail_url,image_url}', 'limit' => 200], $activeToken);
if ($ads && !empty($ads['data'])) {
    $thumbs = [];
    foreach ($ads['data'] as $ad) {
        $n = trim((string) ($ad['name'] ?? ''));
        if ($n === '' || isset($thumbs[$n])) continue;
        $cr = $ad['creative'] ?? [];
        $img = $cr['image_url'] ?? ($cr['thumbnail_url'] ?? '');
        if ($img) $thumbs[$n] = $img;
    }
    if ($thumbs) $extras['thumbs'] = $thumbs;
}

echo json_encode([
    'ok'       => true,
    'main'     => $main,
    'platform' => count($platform) > 1 ? $platform : null,
    'extras'   => $extras,
    'meta'     => [
        'account'       => $accountId,
        'bm'            => $tokens[$tIdx]['label'],
        'month'         => $month,
        'since'         => $since,
        'until'         => $until,
        'rows_main'     => count($main) - 1,
        'rows_platform' => count($platform) - 1,
    ],
], JSON_UNESCAPED_UNICODE);
