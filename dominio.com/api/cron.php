<?php
/**
 * Banco de Imagens — Cache warmer.
 *
 * Itera por todas as bases configuradas em `BASES`, recarrega a planilha
 * de casos e força a geração de thumbnails locais para cada caso. O
 * objetivo é manter o cache em disco quente para que o primeiro acesso
 * pela interface web seja servido sem chamadas ao Google Drive.
 *
 * O script pode ser executado via CLI (cron de sistema) ou por HTTP
 * autenticado pela constante `CRON_KEY`. Em modo HTTP, a saída é
 * transmitida em streaming (text/plain) para acompanhamento em tempo real.
 */

$isCli = (PHP_SAPI === 'cli');

if (!$isCli) {
    if (!defined('WEB_ROOT')) define('WEB_ROOT', dirname(__DIR__));
    require_once __DIR__ . '/../../private-config/config.php';
    // Aceita a chave via header `X-Cron-Key` (preferencial) ou via GET para
    // compatibilidade com integrações antigas. A versão por header não
    // aparece nos logs de acesso do servidor web nem no histórico do browser.
    $key = $_SERVER['HTTP_X_CRON_KEY'] ?? ($_GET['key'] ?? '');
    if (!defined('CRON_KEY') || !hash_equals(CRON_KEY, $key)) {
        http_response_code(403);
        echo json_encode(['ok'=>false,'error'=>'Chave inválida.']);
        exit;
    }
    header('Content-Type: text/plain; charset=utf-8');
    @ob_end_flush();
    flush();
}

set_time_limit(600);
ini_set('memory_limit', '256M');

if (!defined('WEB_ROOT')) define('WEB_ROOT', dirname(__DIR__));
require_once __DIR__ . '/../../private-config/config.php';
require_once __DIR__ . '/../../private-config/lib/db.php';
require_once __DIR__ . '/../../private-config/lib/google.php';

$log = function(string $msg) use ($isCli) {
    $line = '['.date('H:i:s').'] '.$msg;
    echo $line."\n";
    if (!$isCli) { flush(); ob_flush(); }
};

$log('=== Cache warmer iniciado ===');
$log('Resolução de thumbnails: s150');

try { DB::setup(); $log('MySQL OK'); }
catch (Throwable $e) { $log('ERRO MySQL: '.$e->getMessage()); exit(1); }

$total   = 0;
$cached  = 0;
$skipped = 0;
$errors  = 0;
$thumbFiles = 0;

foreach (BASES as $baseKey => $baseCfg) {
    DB::setPrefix($baseCfg['db_prefix']);
    $thumbDir = $baseCfg['thumb_dir'];

    $log("--- Base: {$baseKey} ---");

    try {
        $api   = new GoogleAPI($baseCfg);
        $casos = $api->getCasos(true);
        $log('Planilha: '.count($casos).' casos carregados');
    } catch (Throwable $e) {
        $log('ERRO planilha ['.$baseKey.']: '.$e->getMessage()); continue;
    }

    $total += count($casos);

    foreach ($casos as $i => $caso) {
        $id = $caso['id'];

        $existing = DB::getThumbCache($id);
        if ($existing !== null) {
            $allFilesOk = true;
            foreach ($existing as $p) {
                if (!empty($p['local_thumb']) && !file_exists($thumbDir.'/'.$p['local_thumb'])) {
                    $allFilesOk = false;
                    break;
                }
            }
            if ($allFilesOk) { $skipped++; continue; }
        }

        try {
            $photos = $api->getDrivePhotos($id, true);
            $cached++;
            if (($i+1) % 20 === 0 || count($photos) > 0) {
                $log("[$cached cached / $skipped skip / $errors err] {$id}: ".count($photos)." foto(s)");
            }
        } catch (Throwable $e) {
            $errors++;
            $log("ERRO {$id}: ".$e->getMessage());
        }

        if (($i+1) % 15 === 0) { sleep(1); }
    }

    try {
        $novos = $api->getDriveNewFiles(7);
        if ($novos) $log('Novos no Drive (7d): '.count($novos));
    } catch (Throwable $e) {}

    $thumbFiles += is_dir($thumbDir) ? count(glob($thumbDir.'/*.{jpg,webp}', GLOB_BRACE)) : 0;
}

$log('');
$log('=== Concluído ===');
$log("Total casos: {$total}");
$log("Novos/atualizados: {$cached}");
$log("Já em cache: {$skipped}");
$log("Erros: {$errors}");
$log("Arquivos em /thumbs/: {$thumbFiles}");

if (!$isCli) {
    echo json_encode(['ok'=>true,'total'=>$total,'cached'=>$cached,'skipped'=>$skipped,'errors'=>$errors,'thumb_files'=>$thumbFiles]);
}
