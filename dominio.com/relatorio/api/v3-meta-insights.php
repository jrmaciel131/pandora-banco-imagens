<?php
/**
 * Relatório V3 — ponte com a API de Marketing da Meta (Graph API).
 *
 * Recebe { account, month } de um usuário JÁ AUTENTICADO no Pandora, consulta
 * os insights da conta de anúncios e devolve os números no MESMO formato tabular
 * que um export de Excel teria — as mesmas colunas que o parser do relatório
 * (discoverV2) já entende. Assim a V3 reaproveita 100% do motor da V2.
 *
 * Princípios de segurança:
 *   - Exige sessão do Pandora (mesmo cookie bi_session) + token CSRF em POST.
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

/* Qualquer crash vira JSON (nunca uma página 500 muda), no mesmo espírito do handler.php. */
set_exception_handler(function (Throwable $e) {
    if (!headers_sent()) http_response_code(500);
    echo json_encode(['ok' => false, 'error' => $e->getMessage(), 'code' => 'EXCEPTION'], JSON_UNESCAPED_UNICODE);
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
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Configuração do servidor não encontrada.', 'code' => 'NO_CONFIG'], JSON_UNESCAPED_UNICODE);
    exit;
}
require_once $cfgPath;

/* ── 2) Sessão idêntica ao handler.php → compartilha o login do Pandora ──── */
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

/* Garante um token CSRF na sessão (igual ao handler.php) para validar o POST. */
if (empty($_SESSION['csrf'])) $_SESSION['csrf'] = bin2hex(random_bytes(32));

/** Responde um erro em JSON e encerra. */
function fail($code, $msg, $http = 400) {
    http_response_code($http);
    echo json_encode(['ok' => false, 'error' => $msg, 'code' => $code], JSON_UNESCAPED_UNICODE);
    exit;
}

/* ── 3) Exige login do Pandora ────────────────────────────────────────────
   Só a V3 é protegida; V1/V2 (subir Excel) continuam abertas. */
if (empty($_SESSION['user'])) {
    fail('AUTH', 'Você precisa estar logado no Pandora para usar a V3.', 401);
}
if (isset($_SESSION['login_time']) && (time() - $_SESSION['login_time']) > SESSION_LIFETIME) {
    fail('SESSION_EXPIRED', 'Sua sessão expirou. Faça login novamente.', 401);
}

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
$debug     = !empty($body['debug']);                  // ?debug=1 → lista tipos de ação

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
if (!$tokens) {
    fail('NOT_CONFIGURED', 'A API da Meta ainda não foi configurada no servidor (nenhum token). Veja relatorio/DEPLOY-V3.md.', 503);
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
            foreach (metaFetchAccounts($tk['token']) as $acc) {
                $acc['t'] = $ti; $acc['bm'] = $tk['label'];
                $list[] = $acc;
            }
        }
        usort($list, function ($a, $b) { return strcasecmp($a['label'], $b['label']); });
    }
    echo json_encode(['ok' => true, 'accounts' => $list, 'auto' => !$curated, 'multi' => count($tokens) > 1, 'csrf' => $_SESSION['csrf']], JSON_UNESCAPED_UNICODE);
    exit;
}
if (!preg_match('/^\d{4}-\d{2}$/', $month)) {
    fail('BAD_MONTH', 'Mês inválido. Use o formato AAAA-MM (ex.: 2026-04).');
}
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

/* ── 7) Intervalo do mês escolhido ────────────────────────────────────────
   since = dia 1; until = último dia do mês (date('t')). */
$since = $month . '-01';
$tsSince = strtotime($since);
if ($tsSince === false) fail('BAD_MONTH', 'Mês inválido.');
$until = date('Y-m-t', $tsSince);

/* Lista as contas de anúncios que o token enxerga (modo automático, usado
   quando META_ACCOUNTS está vazio). Adicionar um cliente passa a ser só fazer a
   parceria/atribuição na Meta — sem editar arquivo no servidor. */
function metaFetchAccounts($token) {
    $rows = metaGet('me/adaccounts', ['fields' => 'account_id,name', 'limit' => 200], $token);
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
function metaGet($path, array $params, $token) {
    $base = 'https://graph.facebook.com/' . META_API_VERSION . '/' . ltrim($path, '/');
    $url  = $base . '?' . http_build_query($params);
    $out  = [];
    $guard = 0;
    while ($url && $guard++ < 60) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 90,
            CURLOPT_CONNECTTIMEOUT => 20,
            CURLOPT_HTTPHEADER     => ['Accept: application/json', 'Authorization: Bearer ' . $token],
        ]);
        $raw   = curl_exec($ch);
        $errno = curl_errno($ch);
        $cerr  = curl_error($ch);
        curl_close($ch);
        if ($errno) fail('NETWORK', 'Não consegui falar com a Meta (rede): ' . $cerr, 502);

        $j = json_decode($raw, true);
        if (!is_array($j)) fail('BAD_RESPONSE', 'Resposta inesperada da Meta.', 502);

        if (isset($j['error'])) {
            $m    = $j['error']['message'] ?? 'erro desconhecido';
            $code = (int)($j['error']['code'] ?? 0);
            if (in_array($code, [190, 102, 463, 467], true)) {
                fail('TOKEN', 'O token da Meta está inválido ou expirou. Gere um novo (passo a passo no DEPLOY-V3.md).', 502);
            }
            if (in_array($code, [10, 200, 272, 803], true)) {
                fail('PERMISSION', 'Sem permissão para ler esta conta. Confira se a parceria/atribuição da conta ao Usuário do Sistema está ativa.', 502);
            }
            if ($code === 17 || $code === 4 || $code === 80000) {
                fail('RATE_LIMIT', 'A Meta está limitando as consultas no momento. Espere alguns minutos e tente de novo.', 429);
            }
            fail('META_API', 'Meta: ' . $m, 502);
        }

        if (isset($j['data']) && is_array($j['data'])) $out = array_merge($out, $j['data']);
        $url = $j['paging']['next'] ?? null;
    }
    return $out;
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

/* Modo depuração: lista os tipos de ação presentes, para ajudar a mapear. */
if ($debug) {
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

echo json_encode([
    'ok'       => true,
    'main'     => $main,
    'platform' => count($platform) > 1 ? $platform : null,
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
