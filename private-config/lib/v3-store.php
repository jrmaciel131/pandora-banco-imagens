<?php
/**
 * Relatório V3 — Persistência (perfis, cache de relatórios, criativos e log).
 *
 * Reaproveita a conexão PDO singleton de db.php, mas mantém tabelas próprias
 * (prefixo fixo `v3_`, sem relação com os prefixos de base do Banco de Imagens).
 *
 * Toda operação é resiliente: qualquer falha de banco devolve null/false e
 * deixa o chamador seguir com a busca ao vivo na Meta. O cache nunca pode ser
 * um novo ponto único de falha do relatório.
 */
require_once __DIR__ . '/db.php';

class V3Store {
    /** Janela de retenção dos relatórios salvos. */
    const RETENTION_DAYS = 90;
    /** Validade do cache para períodos ainda não consolidados (em segundos). */
    const OPEN_TTL = 21600;            // 6 horas
    /** Validade do cache da lista de contas (em segundos). */
    const ACCOUNTS_TTL = 86400;        // 24 horas
    /** Dias recentes em que a Meta ainda revisa os números (atribuição). */
    const ATTRIBUTION_LAG_DAYS = 3;

    private static $ready = false;

    /** Conexão PDO compartilhada; null se o banco estiver indisponível. */
    private static function db(): ?PDO {
        try { return DB::get(); } catch (Throwable $e) { return null; }
    }

    /** Cria as tabelas uma vez por processo. Silencioso em caso de falha. */
    public static function setup(): bool {
        if (self::$ready) return true;
        $db = self::db();
        if (!$db) return false;
        try {
            $db->exec("CREATE TABLE IF NOT EXISTS v3_profile (
                account_id   VARCHAR(40)  NOT NULL,
                bm           VARCHAR(80)  NOT NULL DEFAULT '',
                label        VARCHAR(190) NOT NULL DEFAULT '',
                display_name VARCHAR(190) NOT NULL DEFAULT '',
                photo_b64    LONGTEXT     NULL,
                photo_mime   VARCHAR(40)  NULL,
                photo_source VARCHAR(12)  NULL,
                photo_updated_at DATETIME NULL,
                last_seen_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, bm)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $db->exec("CREATE TABLE IF NOT EXISTS v3_account_list (
                cache_key  VARCHAR(120) NOT NULL,
                data_json  MEDIUMTEXT   NOT NULL,
                updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (cache_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $db->exec("CREATE TABLE IF NOT EXISTS v3_report_cache (
                account_id   VARCHAR(40) NOT NULL,
                since_date   DATE        NOT NULL,
                until_date   DATE        NOT NULL,
                payload_json LONGTEXT    NOT NULL,
                is_final     TINYINT(1)  NOT NULL DEFAULT 0,
                fetched_at   DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, since_date, until_date)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            $db->exec("CREATE TABLE IF NOT EXISTS v3_creative (
                account_id VARCHAR(40)  NOT NULL,
                name_key   CHAR(40)     NOT NULL,
                ad_name    VARCHAR(255) NOT NULL,
                img_b64    LONGTEXT     NOT NULL,
                img_mime   VARCHAR(40)  NOT NULL DEFAULT 'image/jpeg',
                calc       VARCHAR(20)  NOT NULL DEFAULT '',
                updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (account_id, name_key)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            // Migração idempotente: carimbo da versão de cálculo nos criativos
            // (bancos criados antes desta coluna existir).
            try { $db->exec("ALTER TABLE v3_creative ADD COLUMN calc VARCHAR(20) NOT NULL DEFAULT ''"); }
            catch (PDOException $e) {}

            $db->exec("CREATE TABLE IF NOT EXISTS v3_api_log (
                id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                usuario    VARCHAR(80) NOT NULL DEFAULT '',
                account_id VARCHAR(40) NOT NULL DEFAULT '',
                endpoint   VARCHAR(60) NOT NULL DEFAULT '',
                ms         INT         NOT NULL DEFAULT 0,
                http       INT         NOT NULL DEFAULT 0,
                buc_pct    INT         NOT NULL DEFAULT 0,
                from_cache TINYINT(1)  NOT NULL DEFAULT 0,
                criado_em  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_criado (criado_em)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

            self::$ready = true;
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }

    /** Chave de deduplicação por nome de anúncio (minúsculas, sem acento/símbolo). */
    public static function normName(string $s): string {
        $s = mb_strtolower($s, 'UTF-8');
        if (class_exists('Normalizer')) {
            $d = \Normalizer::normalize($s, \Normalizer::FORM_D);
            if (is_string($d)) $s = preg_replace('/\p{Mn}+/u', '', $d);
        } else {
            $s = strtr($s, [
                'á'=>'a','à'=>'a','â'=>'a','ã'=>'a','ä'=>'a',
                'é'=>'e','è'=>'e','ê'=>'e','ë'=>'e',
                'í'=>'i','ì'=>'i','î'=>'i','ï'=>'i',
                'ó'=>'o','ò'=>'o','ô'=>'o','õ'=>'o','ö'=>'o',
                'ú'=>'u','ù'=>'u','û'=>'u','ü'=>'u',
                'ç'=>'c','ñ'=>'n',
            ]);
        }
        return (string) preg_replace('/[^a-z0-9]/', '', $s);
    }

    /** Verdadeiro quando o período já está consolidado (fora da janela de atribuição). */
    public static function isFinal(string $until): bool {
        $u = strtotime($until . ' 23:59:59');
        return $u !== false && $u < strtotime('-' . self::ATTRIBUTION_LAG_DAYS . ' days');
    }

    // ── Lista de contas ───────────────────────────────────────────────────
    public static function getAccountList(string $key): ?array {
        $db = self::db();
        if (!$db) return null;
        try {
            $st = $db->prepare("SELECT data_json FROM v3_account_list
                                WHERE cache_key=? AND updated_at > DATE_SUB(NOW(), INTERVAL ? SECOND)");
            $st->execute([$key, self::ACCOUNTS_TTL]);
            $r = $st->fetch();
            return $r ? json_decode($r['data_json'], true) : null;
        } catch (Throwable $e) { return null; }
    }

    public static function setAccountList(string $key, array $data): void {
        $db = self::db();
        if (!$db) return;
        try {
            $db->prepare("INSERT INTO v3_account_list (cache_key,data_json,updated_at) VALUES (?,?,NOW())
                          ON DUPLICATE KEY UPDATE data_json=VALUES(data_json),updated_at=NOW()")
               ->execute([$key, json_encode($data, JSON_UNESCAPED_UNICODE)]);
        } catch (Throwable $e) {}
    }

    public static function clearAccountList(string $key): void {
        $db = self::db();
        if (!$db) return;
        try { $db->prepare("DELETE FROM v3_account_list WHERE cache_key=?")->execute([$key]); }
        catch (Throwable $e) {}
    }

    // ── Perfis (um por conta de anúncios) ─────────────────────────────────
    public static function upsertProfile(string $account, string $bm, string $label): void {
        $db = self::db();
        if (!$db || $account === '') return;
        try {
            $db->prepare("INSERT INTO v3_profile (account_id,bm,label,display_name,last_seen_at,updated_at)
                          VALUES (?,?,?,?,NOW(),NOW())
                          ON DUPLICATE KEY UPDATE label=VALUES(label),
                            display_name=IF(display_name='',VALUES(display_name),display_name),
                            last_seen_at=NOW()")
               ->execute([$account, $bm, $label, $label]);
        } catch (Throwable $e) {}
    }

    /** Foto do perfil pronta como data URL, ou null. */
    public static function getProfilePhoto(string $account, string $bm): ?string {
        $db = self::db();
        if (!$db) return null;
        try {
            $st = $db->prepare("SELECT photo_b64,photo_mime FROM v3_profile WHERE account_id=? AND bm=?");
            $st->execute([$account, $bm]);
            $r = $st->fetch();
            if (!$r || empty($r['photo_b64'])) return null;
            return 'data:' . ($r['photo_mime'] ?: 'image/jpeg') . ';base64,' . $r['photo_b64'];
        } catch (Throwable $e) { return null; }
    }

    /** Verdadeiro se o perfil já tem uma foto salva (sem carregar os bytes). */
    public static function hasPhoto(string $account, string $bm): bool {
        $db = self::db();
        if (!$db) return false;
        try {
            $st = $db->prepare("SELECT 1 FROM v3_profile
                                WHERE account_id=? AND bm=? AND photo_b64 IS NOT NULL AND photo_b64<>'' LIMIT 1");
            $st->execute([$account, $bm]);
            return (bool) $st->fetchColumn();
        } catch (Throwable $e) { return false; }
    }

    public static function setProfilePhoto(string $account, string $bm, string $label, string $b64, string $mime, string $source): void {
        $db = self::db();
        if (!$db || $account === '') return;
        try {
            $db->prepare("INSERT INTO v3_profile (account_id,bm,label,display_name,photo_b64,photo_mime,photo_source,photo_updated_at,last_seen_at,updated_at)
                          VALUES (?,?,?,?,?,?,?,NOW(),NOW(),NOW())
                          ON DUPLICATE KEY UPDATE photo_b64=VALUES(photo_b64),photo_mime=VALUES(photo_mime),
                            photo_source=VALUES(photo_source),photo_updated_at=NOW(),updated_at=NOW()")
               ->execute([$account, $bm, $label, $label, $b64, $mime, $source]);
        } catch (Throwable $e) {}
    }

    // ── Cache de relatórios ───────────────────────────────────────────────
    /** Devolve o relatório salvo se ainda válido, com a data de captura. */
    public static function getReport(string $account, string $since, string $until): ?array {
        $db = self::db();
        if (!$db) return null;
        try {
            $st = $db->prepare("SELECT payload_json,is_final,fetched_at FROM v3_report_cache
                                WHERE account_id=? AND since_date=? AND until_date=?");
            $st->execute([$account, $since, $until]);
            $r = $st->fetch();
            if (!$r) return null;
            $fresh = $r['is_final']
                ? (strtotime($r['fetched_at']) > strtotime('-' . self::RETENTION_DAYS . ' days'))
                : (strtotime($r['fetched_at']) > time() - self::OPEN_TTL);
            if (!$fresh) return null;
            $payload = json_decode($r['payload_json'], true);
            if (!is_array($payload)) return null;
            return ['payload' => $payload, 'fetched_at' => $r['fetched_at'], 'is_final' => (int) $r['is_final']];
        } catch (Throwable $e) { return null; }
    }

    public static function setReport(string $account, string $since, string $until, array $payload, bool $final): void {
        $db = self::db();
        if (!$db || $account === '') return;
        try {
            $db->prepare("INSERT INTO v3_report_cache (account_id,since_date,until_date,payload_json,is_final,fetched_at)
                          VALUES (?,?,?,?,?,NOW())
                          ON DUPLICATE KEY UPDATE payload_json=VALUES(payload_json),is_final=VALUES(is_final),fetched_at=NOW()")
               ->execute([$account, $since, $until, json_encode($payload, JSON_UNESCAPED_UNICODE), $final ? 1 : 0]);
        } catch (Throwable $e) {}
    }

    /**
     * Menor relatório salvo (ainda válido) cujo intervalo COBRE [since,until].
     * Como os relatórios são granulares por dia, um período maior pode ser
     * recortado para servir um menor sem nova chamada à Meta (ex.: do mensal
     * saem as duas quinzenas e qualquer personalizado dentro do mês).
     */
    public static function findCoveringReport(string $account, string $since, string $until): ?array {
        $db = self::db();
        if (!$db) return null;
        try {
            $st = $db->prepare("SELECT since_date,until_date,payload_json,is_final,fetched_at FROM v3_report_cache
                                WHERE account_id=? AND since_date<=? AND until_date>=?
                                ORDER BY DATEDIFF(until_date,since_date) ASC, fetched_at DESC LIMIT 1");
            $st->execute([$account, $since, $until]);
            $r = $st->fetch();
            if (!$r) return null;
            $fresh = $r['is_final']
                ? (strtotime($r['fetched_at']) > strtotime('-' . self::RETENTION_DAYS . ' days'))
                : (strtotime($r['fetched_at']) > time() - self::OPEN_TTL);
            if (!$fresh) return null;
            $payload = json_decode($r['payload_json'], true);
            if (!is_array($payload)) return null;
            return ['payload' => $payload, 'since' => $r['since_date'], 'until' => $r['until_date'], 'fetched_at' => $r['fetched_at']];
        } catch (Throwable $e) { return null; }
    }

    // ── Cache de criativos (bytes, dedup por nome) ────────────────────────
    /** Mapa nome→dataURL dos criativos já salvos (com a versão de cálculo atual). */
    public static function getCreatives(string $account, array $names, string $calc = ''): array {
        $db = self::db();
        if (!$db || !$names) return [];
        try {
            $keys = array_values(array_unique(array_map([self::class, 'normName'], $names)));
            $place = implode(',', array_fill(0, count($keys), '?'));
            $st = $db->prepare("SELECT ad_name,img_b64,img_mime FROM v3_creative
                                WHERE account_id=? AND calc=? AND name_key IN ($place)");
            $st->execute(array_merge([$account, $calc], $keys));
            $out = [];
            foreach ($st->fetchAll() as $r) {
                $out[$r['ad_name']] = 'data:' . ($r['img_mime'] ?: 'image/jpeg') . ';base64,' . $r['img_b64'];
            }
            return $out;
        } catch (Throwable $e) { return []; }
    }

    /** Nomes sem criativo salvo na versão de cálculo atual (após dedup por nome). */
    public static function missingCreativeNames(string $account, array $names, string $calc = ''): array {
        $db = self::db();
        $byKey = [];
        foreach ($names as $n) { $k = self::normName($n); if ($k !== '' && !isset($byKey[$k])) $byKey[$k] = $n; }
        if (!$db || !$byKey) return array_values($byKey);
        try {
            $keys = array_keys($byKey);
            $place = implode(',', array_fill(0, count($keys), '?'));
            $st = $db->prepare("SELECT name_key FROM v3_creative WHERE account_id=? AND calc=? AND name_key IN ($place)");
            $st->execute(array_merge([$account, $calc], $keys));
            foreach ($st->fetchAll() as $r) unset($byKey[$r['name_key']]);
            return array_values($byKey);
        } catch (Throwable $e) { return array_values($byKey); }
    }

    public static function setCreative(string $account, string $name, string $b64, string $mime, string $calc = ''): void {
        $db = self::db();
        if (!$db || $account === '' || $name === '') return;
        try {
            $db->prepare("INSERT INTO v3_creative (account_id,name_key,ad_name,img_b64,img_mime,calc,updated_at)
                          VALUES (?,?,?,?,?,?,NOW())
                          ON DUPLICATE KEY UPDATE ad_name=VALUES(ad_name),img_b64=VALUES(img_b64),img_mime=VALUES(img_mime),calc=VALUES(calc),updated_at=NOW()")
               ->execute([$account, self::normName($name), $name, $b64, $mime, $calc]);
        } catch (Throwable $e) {}
    }

    public static function clearCreatives(string $account): void {
        $db = self::db();
        if (!$db) return;
        try { $db->prepare("DELETE FROM v3_creative WHERE account_id=?")->execute([$account]); }
        catch (Throwable $e) {}
    }

    /** Todos os criativos salvos de uma conta (nome→dataURL), para a galeria. */
    public static function getAllCreatives(string $account): array {
        $db = self::db();
        if (!$db) return [];
        try {
            $st = $db->prepare("SELECT ad_name,img_b64,img_mime FROM v3_creative WHERE account_id=? ORDER BY ad_name");
            $st->execute([$account]);
            $out = [];
            foreach ($st->fetchAll() as $r) {
                $out[] = ['name' => $r['ad_name'], 'url' => 'data:' . ($r['img_mime'] ?: 'image/jpeg') . ';base64,' . $r['img_b64']];
            }
            return $out;
        } catch (Throwable $e) { return []; }
    }

    // ── Gerenciamento de perfis (modal da tela inicial) ───────────────────
    /** Perfis com contagens de relatórios/criativos e a lista de períodos em cache. */
    public static function profilesOverview(): array {
        $db = self::db();
        if (!$db) return [];
        try {
            $profs = $db->query("SELECT account_id,bm,label,display_name,photo_source,photo_updated_at,last_seen_at,
                (photo_b64 IS NOT NULL AND photo_b64<>'') AS has_photo
                FROM v3_profile ORDER BY label")->fetchAll();
            $repCounts = []; foreach ($db->query("SELECT account_id,COUNT(*) c FROM v3_report_cache GROUP BY account_id") as $r) $repCounts[$r['account_id']] = (int) $r['c'];
            $creCounts = []; foreach ($db->query("SELECT account_id,COUNT(*) c FROM v3_creative GROUP BY account_id") as $r) $creCounts[$r['account_id']] = (int) $r['c'];
            $repList = [];
            foreach ($db->query("SELECT account_id,since_date,until_date,is_final,fetched_at FROM v3_report_cache ORDER BY since_date DESC") as $r) {
                $repList[$r['account_id']][] = ['since' => $r['since_date'], 'until' => $r['until_date'], 'is_final' => (int) $r['is_final'], 'fetched_at' => $r['fetched_at']];
            }
            $out = [];
            foreach ($profs as $p) {
                $a = $p['account_id'];
                $out[] = [
                    'account_id' => $a, 'bm' => $p['bm'], 'label' => $p['label'] ?: $p['display_name'],
                    'has_photo' => (bool) $p['has_photo'], 'photo_source' => $p['photo_source'],
                    'photo_updated_at' => $p['photo_updated_at'], 'last_seen_at' => $p['last_seen_at'],
                    'reports_count' => $repCounts[$a] ?? 0, 'creatives_count' => $creCounts[$a] ?? 0,
                    'reports' => $repList[$a] ?? [],
                ];
            }
            return $out;
        } catch (Throwable $e) { return []; }
    }

    /** Apaga relatórios e criativos em cache de uma conta (mantém o perfil/foto). */
    public static function clearProfileCache(string $account): void {
        $db = self::db();
        if (!$db) return;
        try {
            $db->prepare("DELETE FROM v3_report_cache WHERE account_id=?")->execute([$account]);
            $db->prepare("DELETE FROM v3_creative WHERE account_id=?")->execute([$account]);
        } catch (Throwable $e) {}
    }

    public static function removePhoto(string $account, string $bm): void {
        $db = self::db();
        if (!$db) return;
        try {
            $db->prepare("UPDATE v3_profile SET photo_b64=NULL,photo_mime=NULL,photo_source=NULL,photo_updated_at=NULL,updated_at=NOW()
                          WHERE account_id=? AND bm=?")->execute([$account, $bm]);
        } catch (Throwable $e) {}
    }

    // ── Log e medidor de consumo da API ───────────────────────────────────
    public static function logCall(string $usuario, string $account, string $endpoint, int $ms, int $http, int $bucPct, bool $fromCache): void {
        $db = self::db();
        if (!$db) return;
        try {
            $db->prepare("INSERT INTO v3_api_log (usuario,account_id,endpoint,ms,http,buc_pct,from_cache,criado_em)
                          VALUES (?,?,?,?,?,?,?,NOW())")
               ->execute([$usuario, $account, $endpoint, $ms, $http, $bucPct, $fromCache ? 1 : 0]);
        } catch (Throwable $e) {}
    }

    /** Chamadas ao vivo de hoje e maior uso de cota observado. */
    public static function usageToday(): array {
        $db = self::db();
        if (!$db) return ['calls' => 0, 'max_buc' => 0];
        try {
            $st = $db->query("SELECT COUNT(*) c, COALESCE(MAX(buc_pct),0) m FROM v3_api_log
                              WHERE from_cache=0 AND criado_em >= CURDATE()");
            $r = $st->fetch();
            return ['calls' => (int) $r['c'], 'max_buc' => (int) $r['m']];
        } catch (Throwable $e) { return ['calls' => 0, 'max_buc' => 0]; }
    }

    /**
     * Limpeza diária por demanda (piggyback): roda no máximo uma vez por dia,
     * disparada pelo primeiro acesso. Sem cron — nenhuma requisição agendada.
     */
    public static function dailyCleanup(): void {
        $db = self::db();
        if (!$db) return;
        try {
            $st = $db->prepare("SELECT data_json FROM v3_account_list WHERE cache_key='__cleanup__'");
            $st->execute();
            $r = $st->fetch();
            $last = $r ? trim((string) json_decode($r['data_json'], true)) : '';
            if ($last === date('Y-m-d')) return;

            // Retenção rolante: mantém os últimos 3 meses por PERÍODO (until_date).
            // Ao virar o mês, o relatório que ficou com 4 meses sai do cache.
            $db->exec("DELETE FROM v3_report_cache WHERE until_date < DATE_SUB(CURDATE(), INTERVAL 3 MONTH)");
            $db->exec("DELETE FROM v3_api_log WHERE criado_em < DATE_SUB(NOW(), INTERVAL 30 DAY)");

            $db->prepare("INSERT INTO v3_account_list (cache_key,data_json,updated_at) VALUES ('__cleanup__',?,NOW())
                          ON DUPLICATE KEY UPDATE data_json=VALUES(data_json),updated_at=NOW()")
               ->execute([json_encode(date('Y-m-d'))]);
        } catch (Throwable $e) {}
    }
}
