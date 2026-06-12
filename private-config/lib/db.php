<?php
/**
 * Banco de Imagens — Camada de banco de dados (PDO/MySQL).
 *
 * Concentra a conexão singleton, o bootstrap de schema e os helpers de
 * cache (sheet/folder/thumb), auditoria e controle de tentativas de login.
 * Reside fora do document root (em `private-config/lib/`) e deve ser
 * incluído pelos entry scripts via `require_once`.
 */
require_once __DIR__ . '/../config.php';

/**
 * Fachada estática sobre uma única conexão PDO.
 *
 * O prefixo definido por {@see self::setPrefix()} é aplicado a todos os
 * nomes de tabela, isolando os dados de cada base configurada em
 * `BASES` (ex.: '' para PH, 'po_' para PO, 'teste_' para TESTE).
 */
class DB {
    private static $pdo    = null;
    private static $prefix = '';

    /** Define o prefixo das tabelas para a base ativa da requisição. */
    public static function setPrefix(string $p): void { self::$prefix = $p; }

    /** Retorna o prefixo atualmente em uso. */
    public static function getPrefix(): string { return self::$prefix; }

    /** Aplica o prefixo a um nome de tabela. */
    private static function t(string $table): string { return self::$prefix . $table; }

    public static function get(): PDO {
        if (self::$pdo) return self::$pdo;
        self::$pdo = new PDO(
            'mysql:host='.DB_HOST.';dbname='.DB_NAME.';charset=utf8mb4',
            DB_USER, DB_PASS,
            [PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
             PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
             PDO::ATTR_TIMEOUT            => 8]
        );
        return self::$pdo;
    }

    public static function setup(): void {
        $db = self::get();
        $db->exec("CREATE TABLE IF NOT EXISTS ".self::t('thumb_cache')." (
            caso_id     VARCHAR(40)  NOT NULL,
            photos_json MEDIUMTEXT   NOT NULL,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (caso_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $db->exec("CREATE TABLE IF NOT EXISTS ".self::t('folder_cache')." (
            folder_id   VARCHAR(100) NOT NULL,
            subs_json   MEDIUMTEXT   NOT NULL,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (folder_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $db->exec("CREATE TABLE IF NOT EXISTS ".self::t('sheet_cache')." (
            cache_key   VARCHAR(100) NOT NULL,
            data_json   LONGTEXT     NOT NULL,
            updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (cache_key)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        $db->exec("CREATE TABLE IF NOT EXISTS ".self::t('audit_log')." (
            id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            usuario     VARCHAR(80)  NOT NULL,
            caso_id     VARCHAR(40)  NOT NULL,
            acao        VARCHAR(40)  NOT NULL,
            antes_json  TEXT,
            depois_json TEXT,
            ip          VARCHAR(45),
            user_agent  VARCHAR(300),
            criado_em   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_caso    (caso_id),
            INDEX idx_usuario (usuario),
            INDEX idx_criado  (criado_em)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        // Migração idempotente: adiciona a coluna user_agent em bancos legados
        // criados antes desta tabela passar a registrar o cabeçalho HTTP.
        try { $db->exec("ALTER TABLE ".self::t('audit_log')." ADD COLUMN user_agent VARCHAR(300) AFTER ip"); }
        catch (PDOException $e) {}

        $db->exec("CREATE TABLE IF NOT EXISTS ".self::t('login_attempts')." (
            ip            VARCHAR(120) NOT NULL,
            tentativas    INT          NOT NULL DEFAULT 1,
            bloqueado_ate DATETIME,
            ultima_vez    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (ip)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

        // Migração idempotente: a coluna `ip` foi expandida para 120 chars
        // porque agora pode armazenar chaves compostas no formato
        // "u:USUARIO:d:DEVICE_ID" (rate limit por dispositivo+usuário,
        // em vez de só IP — IP compartilhado em rede corporativa bloqueava
        // toda a empresa quando uma pessoa errava a senha).
        try { $db->exec("ALTER TABLE ".self::t('login_attempts')." MODIFY COLUMN ip VARCHAR(120) NOT NULL"); }
        catch (PDOException $e) {}
    }

    // ─────────────────────────────────────────────────────
    // Cache de thumbnails (por caso)
    // ─────────────────────────────────────────────────────

    /**
     * Retorna o JSON decodificado das thumbnails do caso quando ainda
     * dentro do TTL de cache; caso contrário retorna null.
     */
    public static function getThumbCache(string $id, ?int $ttl = null): ?array {
        // $ttl permite checar a idade do cache com uma janela menor que o TTL
        // padrão (usado para revalidar resultados VAZIOS sem esperar os 30 dias).
        $ttl = $ttl ?? (int)THUMB_CACHE_TTL;
        $st = self::get()->prepare(
            "SELECT photos_json FROM ".self::t('thumb_cache')."
             WHERE caso_id=? AND updated_at > DATE_SUB(NOW(), INTERVAL ? SECOND)"
        );
        $st->execute([$id, $ttl]);
        $r = $st->fetch();
        return $r ? json_decode($r['photos_json'], true) : null;
    }

    public static function getThumbCacheRaw(string $id): ?string {
        $st = self::get()->prepare("SELECT photos_json FROM ".self::t('thumb_cache')." WHERE caso_id=?");
        $st->execute([$id]);
        $r = $st->fetch();
        return $r ? $r['photos_json'] : null;
    }

    public static function setThumbCache(string $id, array $photos): void {
        self::get()->prepare(
            "INSERT INTO ".self::t('thumb_cache')." (caso_id,photos_json,updated_at) VALUES (?,?,NOW())
             ON DUPLICATE KEY UPDATE photos_json=VALUES(photos_json),updated_at=NOW()"
        )->execute([$id, json_encode($photos, JSON_UNESCAPED_UNICODE)]);
    }

    public static function clearThumbCache(string $id = ''): void {
        if ($id) self::get()->prepare("DELETE FROM ".self::t('thumb_cache')." WHERE caso_id=?")->execute([$id]);
        else     self::get()->exec("DELETE FROM ".self::t('thumb_cache')."");
    }

    // ─────────────────────────────────────────────────────
    // Cache de subpastas do Drive
    // ─────────────────────────────────────────────────────

    public static function getFolderCache(string $fid): ?array {
        $st = self::get()->prepare(
            "SELECT subs_json FROM ".self::t('folder_cache')."
             WHERE folder_id=? AND updated_at > DATE_SUB(NOW(), INTERVAL ? SECOND)"
        );
        $st->execute([$fid, (int)FOLDER_CACHE_TTL]);
        $r = $st->fetch();
        return $r ? json_decode($r['subs_json'], true) : null;
    }

    public static function setFolderCache(string $fid, array $data): void {
        self::get()->prepare(
            "INSERT INTO ".self::t('folder_cache')." (folder_id,subs_json,updated_at) VALUES (?,?,NOW())
             ON DUPLICATE KEY UPDATE subs_json=VALUES(subs_json),updated_at=NOW()"
        )->execute([$fid, json_encode($data, JSON_UNESCAPED_UNICODE)]);
    }

    public static function clearFolderCache(): void {
        self::get()->exec("DELETE FROM ".self::t('folder_cache')."");
    }

    // ─────────────────────────────────────────────────────
    // Cache de planilhas (Sheets)
    // ─────────────────────────────────────────────────────

    public static function getSheetCache(string $key): ?array {
        $st = self::get()->prepare(
            "SELECT data_json FROM ".self::t('sheet_cache')."
             WHERE cache_key=? AND updated_at > DATE_SUB(NOW(), INTERVAL ? SECOND)"
        );
        $st->execute([$key, (int)CACHE_TTL]);
        $r = $st->fetch();
        return $r ? json_decode($r['data_json'], true) : null;
    }

    public static function setSheetCache(string $key, array $data): void {
        self::get()->prepare(
            "INSERT INTO ".self::t('sheet_cache')." (cache_key,data_json,updated_at) VALUES (?,?,NOW())
             ON DUPLICATE KEY UPDATE data_json=VALUES(data_json),updated_at=NOW()"
        )->execute([$key, json_encode($data, JSON_UNESCAPED_UNICODE)]);
    }

    public static function clearSheetCache(): void {
        self::get()->exec("DELETE FROM ".self::t('sheet_cache')."");
    }

    // ─────────────────────────────────────────────────────
    // Audit log
    // ─────────────────────────────────────────────────────

    /**
     * Registra uma operação no log de auditoria, capturando IP e
     * user-agent automaticamente a partir da requisição corrente.
     *
     * @param mixed $antes  Estado anterior (qualquer valor JSON-serializável) ou null.
     * @param mixed $depois Estado posterior (qualquer valor JSON-serializável) ou null.
     */
    public static function log(string $user, string $caso, string $acao, $antes, $depois): void {
        $ip = substr($_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '', 0, 45);
        $ua = substr($_SERVER['HTTP_USER_AGENT'] ?? '', 0, 300);
        self::get()->prepare(
            "INSERT INTO ".self::t('audit_log')." (usuario,caso_id,acao,antes_json,depois_json,ip,user_agent,criado_em)
             VALUES (?,?,?,?,?,?,?,NOW())"
        )->execute([
            $user, $caso, $acao,
            $antes  ? json_encode($antes,  JSON_UNESCAPED_UNICODE) : null,
            $depois ? json_encode($depois, JSON_UNESCAPED_UNICODE) : null,
            $ip, $ua,
        ]);
    }

    /**
     * Recupera entradas do audit_log com filtros opcionais por caso e usuário.
     *
     * O valor de LIMIT é interpolado como inteiro diretamente no SQL para
     * contornar a quoting do PDO em alguns drivers MySQL — o cast para int
     * impede injeção; os demais filtros seguem o caminho parametrizado.
     */
    public static function getLog(int $limit = 200, string $caso_id = '', string $usuario = '', array $excludeAcoes = []): array {
        $where = []; $params = [];
        if ($caso_id) { $where[] = 'caso_id=?'; $params[] = $caso_id; }
        if ($usuario) { $where[] = 'usuario=?'; $params[] = $usuario; }
        // Permite ocultar certas ações (ex.: 'login_success') do histórico de
        // alterações, sem precisar de uma query dedicada.
        foreach ($excludeAcoes as $ex) { $where[] = 'acao<>?'; $params[] = $ex; }

        $sql = 'SELECT * FROM '.self::t('audit_log')
             . ($where ? ' WHERE ' . implode(' AND ', $where) : '')
             . ' ORDER BY criado_em DESC LIMIT ' . (int)$limit;

        $st = self::get()->prepare($sql);
        $st->execute($params);
        return $st->fetchAll();
    }

    // ─────────────────────────────────────────────────────
    // Controle de tentativas de login (rate limiting por IP)
    // ─────────────────────────────────────────────────────

    /** Indica se o IP está atualmente bloqueado por excesso de falhas. */
    public static function isBlocked(string $ip): bool {
        $st = self::get()->prepare("SELECT bloqueado_ate FROM ".self::t('login_attempts')." WHERE ip=?");
        $st->execute([$ip]);
        $r = $st->fetch();
        return $r && $r['bloqueado_ate'] && strtotime($r['bloqueado_ate']) > time();
    }

    public static function recordFail(string $ip): void {
        self::get()->prepare(
            "INSERT INTO ".self::t('login_attempts')." (ip,tentativas,ultima_vez) VALUES (?,1,NOW())
             ON DUPLICATE KEY UPDATE tentativas=tentativas+1,ultima_vez=NOW(),
             bloqueado_ate=IF(tentativas+1>=?,DATE_ADD(NOW(),INTERVAL ? MINUTE),bloqueado_ate)"
        )->execute([$ip, MAX_LOGIN_ATTEMPTS, LOGIN_BLOCK_MINUTES]);
    }

    public static function clearFails(string $ip): void {
        self::get()->prepare("DELETE FROM ".self::t('login_attempts')." WHERE ip=?")->execute([$ip]);
    }

    public static function blockRemaining(string $ip): int {
        $st = self::get()->prepare("SELECT bloqueado_ate FROM ".self::t('login_attempts')." WHERE ip=?");
        $st->execute([$ip]);
        $r = $st->fetch();
        if ($r && $r['bloqueado_ate']) return max(0, (int)ceil((strtotime($r['bloqueado_ate']) - time()) / 60));
        return 0;
    }
}
