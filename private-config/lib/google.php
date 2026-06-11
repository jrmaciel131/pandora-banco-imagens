<?php
/**
 * Banco de Imagens — Integração com Google Sheets e Google Drive.
 *
 * Encapsula obtenção de token OAuth (JWT de service account), leitura e
 * escrita de planilhas, listagem de pastas e download de arquivos do
 * Drive, além do pipeline de geração de thumbnails locais. Reside fora
 * do document root e é incluído pelos entry scripts via `require_once`.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db.php';

/**
 * Cliente para as APIs do Google atrelado a uma base configurada em `BASES`.
 *
 * A configuração da base ativa é injetada via construtor; isto permite
 * múltiplas instâncias coexistirem na mesma requisição sem depender de
 * constantes globais redefiníveis.
 */
class GoogleAPI {
    private $token = null;
    private $exp   = 0;

    private string $spreadsheetId;
    private string $sheetName;
    private string $driveFolderId;
    private string $thumbDir;
    private string $thumbBaseUrl;

    /**
     * @param array $baseCfg Entrada da constante BASES com as chaves
     *                       spreadsheet_id, sheet_name, drive_folder_id,
     *                       thumb_dir e thumb_base_url.
     */
    public function __construct(array $baseCfg = []) {
        $this->spreadsheetId  = $baseCfg['spreadsheet_id']  ?? '';
        $this->sheetName      = $baseCfg['sheet_name']       ?? '';
        $this->driveFolderId  = $baseCfg['drive_folder_id']  ?? '';
        $this->thumbDir       = $baseCfg['thumb_dir']        ?? '';
        $this->thumbBaseUrl   = $baseCfg['thumb_base_url']   ?? '';
    }

    /** Exposição pública do token (apenas para fins de diagnóstico). */
    public function getAccessTokenPublic(): string { return $this->getToken(); }

    /**
     * Obtém um access token válido, recorrendo, em ordem:
     * cache em memória → cache em disco (TTL ~55 min) → emissão de novo
     * JWT contra o endpoint OAuth do Google.
     */
    private function getToken(): string {
        if ($this->token && time() < $this->exp - 60) return $this->token;

        $cacheFile = PRIVATE_CONFIG_PATH . '/.token_cache.json';
        if (file_exists($cacheFile)) {
            $cached = json_decode(file_get_contents($cacheFile), true);
            if ($cached && !empty($cached['token']) && isset($cached['exp']) && time() < $cached['exp'] - 60) {
                $this->token = $cached['token'];
                $this->exp   = $cached['exp'];
                return $this->token;
            }
        }

        if (!file_exists(GOOGLE_CREDENTIALS_PATH)) throw new Exception('google-credentials.json não encontrado.');
        $c = json_decode(file_get_contents(GOOGLE_CREDENTIALS_PATH),true);
        if (!isset($c['private_key'],$c['client_email'])) throw new Exception('google-credentials.json inválido.');
        $now=time();
        $claim=['iss'=>$c['client_email'],'scope'=>'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.readonly','aud'=>'https://oauth2.googleapis.com/token','iat'=>$now,'exp'=>$now+3600];
        $h=b64u(json_encode(['alg'=>'RS256','typ'=>'JWT']));
        $p=b64u(json_encode($claim));
        $sig='';
        if (!openssl_sign("$h.$p",$sig,$c['private_key'],'SHA256')) throw new Exception('Falha JWT.');
        $jwt="$h.$p.".b64u($sig);
        $resp=hpost('https://oauth2.googleapis.com/token',http_build_query(['grant_type'=>'urn:ietf:params:oauth:grant-type:jwt-bearer','assertion'=>$jwt]),['Content-Type: application/x-www-form-urlencoded']);
        if (!$resp) throw new Exception('Sem resposta OAuth.'.hLastError());
        $d=json_decode($resp,true);
        if (!isset($d['access_token'])) throw new Exception('Token falhou: '.($d['error_description']??json_encode($d)));

        $this->token = $d['access_token'];
        $this->exp   = $now + ($d['expires_in'] ?? 3600);

        @file_put_contents($cacheFile, json_encode(['token'=>$this->token,'exp'=>$this->exp]), LOCK_EX);

        return $this->token;
    }

    // ─────────────────────────────────────────────────────
    // Planilha
    // ─────────────────────────────────────────────────────

    /**
     * Marcadores reconhecidos na coluna C (UFs) que indicam que o caso
     * está bloqueado. A presença de qualquer um destes valores em qualquer
     * posição da lista classifica o caso como bloqueado.
     */
    private const BLOCK_MARKERS = ['NA','LINDA'];

    /** Indica se o valor informado corresponde a um marcador de bloqueio. */
    public static function isBlockMarker(string $v): bool {
        return in_array(strtoupper(trim($v)), self::BLOCK_MARKERS, true);
    }

    /**
     * Versão curta do conteúdo de um caso, usada para detecção de edição
     * concorrente (optimistic locking). Computada de forma idêntica na leitura
     * (getCasos) e após gravações, para que o cliente possa comparar o estado
     * que carregou com o estado atual ao salvar.
     */
    public static function caseVersion(array $ufs, array $cids, array $clis, array $tags, string $motivo): string {
        return substr(sha1(json_encode([
            array_values($ufs), array_values($cids), array_values($clis), array_values($tags), $motivo
        ], JSON_UNESCAPED_UNICODE)), 0, 16);
    }

    /**
     * Deriva uma tag de versão curta a partir do nome de um arquivo do Drive.
     *
     * A convenção esperada é `CASO-XXX-{flag-de-layout}-{código}-...`
     * (ex.: `CASO-102-H-NA-xxxx` → `NA`). Para vídeos retorna `'VIDEO'` e
     * para arquivos WebP retorna `'WEBP'`. Quando nenhum segmento alfabético
     * pode ser extraído, retorna null.
     *
     * @return string|null Tag em maiúsculas, ou null se indeterminável.
     */
    public static function extractVersionTag(string $name, bool $isWebp, bool $isVideo): ?string {
        if ($isVideo) return 'VIDEO';
        if ($isWebp)  return 'WEBP';
        $noExt = preg_replace('/\.[^.]+$/', '', $name);
        $rest = preg_replace('/^CASO-\d+[-_\s]*/i', '', $noExt);
        if ($rest === '' || $rest === null) return null;
        $parts = preg_split('/[-_\s]+/', $rest);
        $shortAlpha = [];
        foreach ($parts as $p) {
            $p = trim($p);
            if ($p === '') continue;
            if (preg_match('/^[A-Z]{1,5}$/i', $p)) $shortAlpha[] = strtoupper($p);
        }
        if (empty($shortAlpha)) {
            $first = trim($parts[0] ?? '');
            return $first === '' ? null : strtoupper(substr($first, 0, 5));
        }
        foreach ($shortAlpha as $s) {
            if (strlen($s) >= 2) return $s;
        }
        return $shortAlpha[0];
    }

    /**
     * Retorna a lista de casos a partir da planilha configurada.
     *
     * O resultado é cacheado em banco; passe `$force = true` para
     * ignorar o cache e reler diretamente do Google Sheets.
     *
     * Estrutura por caso: id, ufs, cidades, clientes, tags,
     * motivo_bloqueio, bloqueado, row.
     *
     * @return array<int, array<string, mixed>>
     */
    public function getCasos(bool $force=false): array {
        $key='sheet_v2_'.md5($this->spreadsheetId.$this->sheetName);
        if (!$force) { $c=DB::getSheetCache($key); if ($c!==null) return $c; }
        $tok=$this->getToken();
        // Faixa A:G — coluna F concentra as tags; coluna G, o motivo do bloqueio.
        $range=urlencode($this->sheetName.'!A:G');
        $resp=hget("https://sheets.googleapis.com/v4/spreadsheets/".$this->spreadsheetId."/values/$range",["Authorization: Bearer $tok"]);
        if (!$resp) throw new Exception('Sem resposta Sheets.'.hLastError());
        $d=json_decode($resp,true);
        if (isset($d['error'])) {
            $code=$d['error']['code']??0;
            if ($code==403) throw new Exception('Sem permissão (403). Compartilhe a planilha com a conta de serviço como Editor.');
            if ($code==404) throw new Exception('Planilha não encontrada (404). Verifique $this->spreadsheetId.');
            throw new Exception('Sheets: '.($d['error']['message']??''));
        }
        $casos=[];
        foreach (($d['values']??[]) as $i=>$row) {
            if ($i<2) continue;
            $id=trim($row[1]??'');
            if (!$id||stripos($id,'CASO')===false) continue;
            $ufs     = array_values(array_filter(array_map('trim',preg_split('/[\/\-]/',strtoupper($row[2]??'')))));
            $cidades = array_values(array_filter(array_map('trim',explode('/',strtoupper($row[3]??'')))));
            $clientes= array_values(array_filter(array_map('trim',explode('/',$row[4]??''))));
            // Coluna F (tags): aceita separadores "/" ou "," e normaliza para uppercase.
            // mb_strtoupper é necessário para preservar acentos (ESTÉTICA, BOTOX, etc).
            $tagsRaw = trim($row[5] ?? '');
            $tags    = $tagsRaw === '' ? [] : array_values(array_filter(array_map(
                fn($t)=>mb_strtoupper(trim($t), 'UTF-8'),
                preg_split('/[\/,]/', $tagsRaw)
            )));
            $motivo  = trim($row[6] ?? '');
            $bloqueado = false;
            foreach ($ufs as $u) if (self::isBlockMarker($u)) { $bloqueado = true; break; }
            $casos[]=[
                'row'              => $i+1,
                'id'               => strtoupper($id),
                'ufs'              => $ufs,
                'cidades'          => $cidades,
                'clientes'         => $clientes,
                'tags'             => $tags,
                'motivo_bloqueio'  => $motivo,
                'bloqueado'        => $bloqueado,
                'ver'              => self::caseVersion($ufs, $cidades, $clientes, $tags, $motivo),
            ];
        }
        DB::setSheetCache($key,$casos);
        return $casos;
    }

    /**
     * Atualiza um caso na planilha.
     *
     * Sem `$tags` e `$motivo`, escreve apenas a faixa C:E (UFs, cidades,
     * clientes), preservando comportamento legado. Quando qualquer um
     * deles é informado, escreve C:G atomicamente; valores ausentes são
     * preenchidos com o estado atual lido do cache para evitar
     * sobrescrever a coluna oposta.
     */
    public function updateCaso(int $row, string $ufs, string $cids, string $clis, ?string $tags=null, ?string $motivo=null): void {
        if ($tags !== null || $motivo !== null) {
            if ($tags === null || $motivo === null) {
                $current = $this->findCasoByRow($row);
                if ($tags === null)    $tags    = $current ? implode('/', $current['tags']) : '';
                if ($motivo === null)  $motivo  = $current ? ($current['motivo_bloqueio'] ?? '') : '';
            }
            $this->writeRange("C{$row}:G{$row}", [[$ufs, $cids, $clis, $tags, $motivo]]);
        } else {
            $this->writeRange("C{$row}:E{$row}", [[$ufs, $cids, $clis]]);
        }
        DB::clearSheetCache();
    }

    /** Atualiza apenas a coluna F (tags), preservando C, D, E e G. */
    public function updateCasoTags(int $row, string $tags): void {
        $this->writeRange("F{$row}:F{$row}", [[$tags]]);
        DB::clearSheetCache();
    }

    /** Atualiza apenas a coluna G (motivo de bloqueio). */
    public function updateCasoMotivo(int $row, string $motivo): void {
        $this->writeRange("G{$row}:G{$row}", [[$motivo]]);
        DB::clearSheetCache();
    }

    private function writeRange(string $a1Range, array $values): void {
        $tok  = $this->getToken();
        $range = urlencode($this->sheetName.'!'.$a1Range);
        $url  = "https://sheets.googleapis.com/v4/spreadsheets/".$this->spreadsheetId."/values/$range?valueInputOption=RAW";
        $body = json_encode(['values'=>$values]);
        $hdrs = ["Authorization: Bearer $tok","Content-Type: application/json"];
        // Reenvio com backoff linear para mitigar instabilidades de rede do host.
        $resp = null;
        for ($i=1; $i<=3; $i++) {
            $resp = hput($url, $body, $hdrs);
            if ($resp !== null) break;
            if ($i < 3) sleep($i);
        }
        if (!$resp) throw new Exception('Sem resposta da API do Google Sheets após 3 tentativas. Verifique allow_url_fopen e a conectividade do servidor.'.hLastError());
        $d = json_decode($resp, true);
        if (isset($d['error'])) throw new Exception('Erro ao gravar na planilha: '.($d['error']['message']??json_encode($d['error'])));
    }

    private function findCasoByRow(int $row): ?array {
        $casos = $this->getCasos(false);
        foreach ($casos as $c) if ((int)$c['row'] === $row) return $c;
        return null;
    }

    // ─────────────────────────────────────────────────────
    // Drive — pastas e arquivos
    // ─────────────────────────────────────────────────────

    /**
     * Coleta IDs da pasta-raiz e de até dois níveis de subpastas, com
     * cache em banco para reduzir round-trips. Resultado também inclui
     * o próprio `driveFolderId` na primeira posição.
     *
     * @return string[]
     */
    public function getAllFolderIds(): array {
        $cached=DB::getFolderCache($this->driveFolderId);
        if ($cached!==null) return $cached;
        $tok=$this->getToken();
        $allIds=[$this->driveFolderId];
        $q=urlencode("'".$this->driveFolderId."' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
        $resp=hget("https://www.googleapis.com/drive/v3/files?q=$q&fields=files(id,name)&pageSize=100",["Authorization: Bearer $tok"]);
        if (!$resp) throw new Exception('Sem resposta listando subpastas.'.hLastError());
        $d=json_decode($resp,true);
        if (isset($d['error'])) throw new Exception('Drive subpastas: '.($d['error']['message']??''));
        foreach (($d['files']??[]) as $sub) {
            $allIds[]=$sub['id'];
            $q2=urlencode("'{$sub['id']}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false");
            $r2=hget("https://www.googleapis.com/drive/v3/files?q=$q2&fields=files(id,name)&pageSize=100",["Authorization: Bearer $tok"]);
            if ($r2) foreach ((json_decode($r2,true)['files']??[]) as $sub2) $allIds[]=$sub2['id'];
        }
        DB::setFolderCache($this->driveFolderId,$allIds);
        return $allIds;
    }

    /**
     * Lista todos os IDs de caso (prefixo CASO + número) presentes nos NOMES
     * dos arquivos no Drive — varre a pasta-raiz e subpastas, com paginação.
     * Usado pela sincronização Drive↔planilha (Solução 1).
     *
     * @return string[] IDs na grafia encontrada (ex.: CASO-001), únicos e ordenados por número.
     */
    public function listDriveCaseIds(): array {
        $tok = $this->getToken();
        $folderIds = $this->getAllFolderIds();
        $found = [];  // numero => "CASO-XXX" (primeira grafia encontrada)
        foreach (array_chunk($folderIds, 30) as $chunk) {
            $parents = implode(' or ', array_map(fn($id)=>"'$id' in parents", $chunk));
            $pageToken = '';
            do {
                $q = urlencode("($parents) and name contains 'CASO' and trashed=false");
                $url = "https://www.googleapis.com/drive/v3/files?q=$q&fields=nextPageToken,files(name)&pageSize=1000";
                if ($pageToken !== '') $url .= "&pageToken=".urlencode($pageToken);
                $resp = hget($url, ["Authorization: Bearer $tok"]);
                if (!$resp) break;
                $d = json_decode($resp, true);
                if (isset($d['error'])) throw new Exception('Drive (sync): '.($d['error']['message']??''));
                foreach (($d['files'] ?? []) as $f) {
                    if (preg_match('/^CASO[-_ ]?(\d+)/i', $f['name'] ?? '', $m)) {
                        $num = (int)$m[1];
                        if (!isset($found[$num])) $found[$num] = 'CASO-'.$m[1]; // preserva grafia (zeros à esquerda)
                    }
                }
                $pageToken = $d['nextPageToken'] ?? '';
            } while ($pageToken !== '');
        }
        ksort($found, SORT_NUMERIC);
        return array_values($found);
    }

    /**
     * Localiza o número da próxima linha vazia da planilha (1-based).
     *
     * Lê a faixa A:G e conta as linhas retornadas — o Sheets descarta linhas
     * finais totalmente vazias, então a contagem corresponde à última linha
     * com dados; a próxima é count+1.
     */
    private function getNextDataRow(): int {
        $tok   = $this->getToken();
        $range = urlencode($this->sheetName.'!A:G');
        $resp  = hget("https://sheets.googleapis.com/v4/spreadsheets/".$this->spreadsheetId."/values/$range", ["Authorization: Bearer $tok"]);
        if (!$resp) throw new Exception('Sem resposta do Sheets ao localizar a última linha.'.hLastError());
        $d = json_decode($resp, true);
        if (isset($d['error'])) throw new Exception('Sheets: '.($d['error']['message']??''));
        return count($d['values'] ?? []) + 1;
    }

    /**
     * Adiciona uma nova linha de caso na planilha com apenas o ID na coluna B
     * (coluna de ID de caso), demais colunas vazias. Usado pela sincronização.
     *
     * Grava diretamente na célula B da próxima linha vazia (values:update) em
     * vez de values:append: o append desalinhava o ID para a coluna C quando a
     * coluna A está inteiramente vazia, pois o Sheets detectava o início da
     * "tabela" na coluna B e deslocava os valores uma coluna à direita.
     */
    public function appendCaso(string $id): void {
        $row = $this->getNextDataRow();
        $this->writeRange("B{$row}:B{$row}", [[$id]]);
        DB::clearSheetCache();
    }

    /**
     * Lista as fotos associadas a um caso, com geração de thumbnails locais.
     *
     * Considera arquivos cujo nome se inicia pelo `caso_id` em qualquer
     * subpasta retornada por {@see self::getAllFolderIds()}. Faz download
     * paralelo das thumbnails, classifica imagens vs. vídeos, identifica
     * a versão (V1, V2, …) e ordena WebP no topo.
     *
     * @return array<int, array<string, mixed>>
     */
    public function getDrivePhotos(string $caso_id, bool $force=false): array {
        if (!$force) {
            $cached=DB::getThumbCache($caso_id);
            if ($cached!==null) {
                if (!empty($cached)) {
                    // Cache COM fotos: valida thumbs locais e reusa pelo TTL cheio.
                    // Um registro íntegro porém sem NENHUMA thumb utilizável (os
                    // downloads falharam quando foi gravado) não pode valer pelos
                    // 30 dias do TTL: é revalidado a cada 5 min, como o cache
                    // vazio, para que as thumbs se regenerem sozinhas.
                    $valid=array_filter($cached,fn($p)=>empty($p['local_thumb'])||file_exists($this->thumbDir.'/'.$p['local_thumb']));
                    if (count($valid)===count($cached)) {
                        $usable=array_filter($cached,fn($p)=>!empty($p['local_thumb'])&&file_exists($this->thumbDir.'/'.$p['local_thumb']));
                        if ($usable) return $cached;
                        if (DB::getThumbCache($caso_id, 300) !== null) return $cached;
                    }
                } else {
                    // Cache VAZIO: só reusa se checado nos últimos 5 min. Senão re-busca
                    // no Drive — resolve fotos adicionadas após um open vazio, sem precisar
                    // limpar cache manualmente (THUMB_CACHE_TTL é de 30 dias).
                    if (DB::getThumbCache($caso_id, 300) !== null) return [];
                }
            }
        }
        $tok=$this->getToken();
        $folderIds=$this->getAllFolderIds();
        $allFiles=[];
        foreach (array_chunk($folderIds,30) as $chunk) {
            $parents=implode(' or ',array_map(fn($id)=>"'$id' in parents",$chunk));
            $q=urlencode("($parents) and name contains '$caso_id' and trashed=false");
            $resp=hget("https://www.googleapis.com/drive/v3/files?q=$q&fields=files(id,name,mimeType,thumbnailLink,webViewLink)&pageSize=100",["Authorization: Bearer $tok"]);
            // Falha de transporte ou erro da API abortam a busca em vez de
            // seguir adiante: um resultado parcial/vazio seria gravado no
            // cache como "caso sem fotos" e mascararia o problema real.
            if (!$resp) throw new Exception('Sem resposta na busca do Drive ('.$caso_id.').'.hLastError());
            $d=json_decode($resp,true);
            if (isset($d['error'])) throw new Exception('Drive ('.$caso_id.'): '.($d['error']['message']??'erro desconhecido').' [HTTP '.($d['error']['code']??'?').']');
            if (isset($d['files'])) $allFiles=array_merge($allFiles,$d['files']);
        }

        // Mantém apenas arquivos cujo nome bate exatamente com o caso_id
        // como prefixo seguido de um separador conhecido.
        $files=array_values(array_filter($allFiles,function($f) use ($caso_id){
            $n=strtoupper($f['name']); $id=strtoupper($caso_id);
            return $n===$id||strpos($n,$id.'-')===0||strpos($n,$id.'_')===0||strpos($n,$id.'.')===0||strpos($n,$id.' ')===0;
        }));

        // Deduplicação por id de arquivo do Drive.
        $seen=[]; $files=array_values(array_filter($files,function($f) use (&$seen){ if(isset($seen[$f['id']])) return false; $seen[$f['id']]=true; return true; }));

        $thumbResults = $this->downloadThumbsBatch(
            array_filter($files, fn($f) => !empty($f['thumbnailLink'])),
            $tok,
            $thumbErrors
        );

        $photos=[];
        foreach ($files as $f) {
            $name=$f['name'];
            $mime=$f['mimeType']??'';
            $ext =strtolower(pathinfo($name,PATHINFO_EXTENSION));
            $isVid=strpos($mime,'video/')===0||in_array($ext,['mp4','mov','avi','mkv','webm']);
            $isWebp=$ext==='webp';

            preg_match('/^(CASO-\d+)/i',$name,$m);
            $base=strtoupper($m[1]??$caso_id);

            $version=null;
            if (preg_match('/[-_](V\d+)(?:[-_.]|$)/i',$name,$vm)) {
                $version=strtoupper($vm[1]);
            }

            // Tag curta usada como badge na interface (ex.: NA, LH, WEBP, VIDEO).
            $version_tag = self::extractVersionTag($name, $isWebp, $isVid);

            $localThumb = $thumbResults[$f['id']] ?? null;

            // Sem thumb local, registra o motivo: ele fica persistido no cache
            // e é exibido nas métricas visuais do modo admin.
            $thumbError = null;
            if ($localThumb === null) {
                $thumbError = $thumbErrors[$f['id']]
                    ?? (empty($f['thumbnailLink']) ? 'Drive não fornece thumbnail para este arquivo' : 'falha no download da thumbnail');
            }

            $photos[]=[
                'id'           =>$f['id'],
                'name'         =>$name,
                'mimeType'     =>$mime,
                'isVideo'      =>$isVid,
                'isWebp'       =>$isWebp,
                'version'      =>$version,
                'version_tag'  =>$version_tag,
                'local_thumb'  =>$localThumb,
                'thumb_error'  =>$thumbError,
                'webViewLink'  =>$f['webViewLink']??null,
                'variant_group'=>$base,
            ];
        }

        // Ordena: arquivos WebP no topo, demais em ordem alfabética.
        usort($photos,function($a,$b){
            if ($a['isWebp']&&!$b['isWebp']) return -1;
            if (!$a['isWebp']&&$b['isWebp']) return 1;
            return strcmp($a['name'],$b['name']);
        });

        DB::setThumbCache($caso_id,$photos);
        return $photos;
    }

    /** Verifica a existência de uma thumbnail local válida sem fazer download. */
    private function thumbExists(string $fid, bool $webp=false): ?string {
        $ext = $webp ? 'webp' : 'jpg';
        $filename = $fid.'.'.$ext;
        $path = $this->thumbDir.'/'.$filename;
        if (file_exists($path) && filesize($path) > 100 && (time()-filemtime($path)) < THUMB_CACHE_TTL) {
            return $filename;
        }
        return null;
    }

    /** Faz o download de uma thumbnail, com fallback sem autenticação. */
    private function downloadThumb(string $fid, string $url, string $tok, bool $webp=false): ?string {
        $existing = $this->thumbExists($fid, $webp);
        if ($existing) return $existing;

        $ext  = $webp ? 'webp' : 'jpg';
        $filename = $fid.'.'.$ext;
        $path = $this->thumbDir.'/'.$filename;

        // Resolução `s150` é a usada no preview em grade da interface.
        $src = preg_replace('/=s\d+$/', '=s150', $url);
        $data = hget($src, ["Authorization: Bearer $tok"]);

        if (!$data || strlen($data) < 100) {
            $data = hget($src, []);
        }

        if (!$data || strlen($data) < 100) return null;
        if (!is_dir($this->thumbDir)) @mkdir($this->thumbDir, 0755, true);
        return @file_put_contents($path, $data) !== false ? $filename : null;
    }

    /**
     * Baixa múltiplas thumbnails em paralelo aproveitando os streams
     * abertos sob stream wrappers do PHP. A operação reduz o tempo total
     * de download de N×T para aproximadamente max(T), uma vez que o SO
     * já trafega os dados em paralelo via TCP enquanto os handles estão
     * abertos.
     *
     * @param array      $files  Lista de arquivos do Drive com `thumbnailLink`.
     * @param string     $tok    Access token a ser usado no cabeçalho Authorization.
     * @param array|null $errors Recebe, por fileId, o motivo de cada download que falhou.
     * @return array<string, string|null> Mapa fileId → filename local (ou null).
     */
    public function downloadThumbsBatch(array $files, string $tok, ?array &$errors = null): array {
        $errors = [];
        if (!is_dir($this->thumbDir)) @mkdir($this->thumbDir, 0755, true);
        $results = [];
        $streams = [];

        foreach ($files as $f) {
            $fid = $f['id'];
            $url = $f['thumbnailLink'] ?? null;
            $isWebp = strtolower(pathinfo($f['name'] ?? '', PATHINFO_EXTENSION)) === 'webp';
            $ext = $isWebp ? 'webp' : 'jpg';
            $filename = $fid.'.'.$ext;
            $path = $this->thumbDir.'/'.$filename;

            if (file_exists($path) && filesize($path) > 100 && (time()-filemtime($path)) < THUMB_CACHE_TTL) {
                $results[$fid] = $filename;
                continue;
            }

            if (!$url) { $results[$fid] = null; continue; }

            $src = preg_replace('/=s\d+$/', '=s150', $url);
            $ctx = stream_context_create(['http'=>[
                'method'        => 'GET',
                'header'        => "Authorization: Bearer $tok\r\n",
                'timeout'       => 15,
                'ignore_errors' => true,
            ]]);
            $streams[$fid] = ['path'=>$path,'filename'=>$filename,'src'=>$src,'ctx'=>$ctx,'isWebp'=>$isWebp];
        }

        $handles = [];
        foreach ($streams as $fid => $s) {
            $h = @fopen($s['src'], 'r', false, $s['ctx']);
            if ($h) $handles[$fid] = ['handle'=>$h,'path'=>$s['path'],'filename'=>$s['filename']];
            else { $results[$fid] = null; $errors[$fid] = 'falha ao abrir o stream da thumbnail no Drive'; }
        }

        foreach ($handles as $fid => $h) {
            $data = @stream_get_contents($h['handle']);
            @fclose($h['handle']);
            if ($data && strlen($data) > 100) {
                // Gravação verificada: disco cheio ou diretório sem permissão
                // não podem passar como download bem-sucedido, senão o cache
                // registra um arquivo que não existe.
                if (@file_put_contents($h['path'], $data) !== false) {
                    $results[$fid] = $h['filename'];
                } else {
                    $results[$fid] = null;
                    $errors[$fid] = 'download OK mas falhou a gravação em disco (disco cheio ou sem permissão?)';
                }
            } else {
                $results[$fid] = null;
                $errors[$fid] = 'resposta vazia/curta do Drive ('.strlen((string)$data).' bytes)';
            }
        }

        return $results;
    }

    public function listDriveFolder(int $max=5): array {
        $tok=$this->getToken();
        $q=urlencode("'".$this->driveFolderId."' in parents and trashed=false");
        $resp=hget("https://www.googleapis.com/drive/v3/files?q=$q&fields=files(id,name)&pageSize=$max",["Authorization: Bearer $tok"]);
        if (!$resp) throw new Exception('Sem resposta listando Drive.'.hLastError());
        $d=json_decode($resp,true);
        if (isset($d['error'])) throw new Exception('Drive: '.($d['error']['message']??''));
        return $d['files']??[];
    }

    /**
     * Baixa o conteúdo binário de um arquivo do Drive autenticando com a
     * conta de serviço. Suporta os endpoints de download direto e o
     * empacotamento ZIP em lote do `handler.php`.
     *
     * @return array{ok:bool, data?:string, name?:string, mime?:string, error?:string}
     */
    public function downloadDriveFile(string $fileId): array {
        $tok = $this->getToken();
        $metaUrl = "https://www.googleapis.com/drive/v3/files/".urlencode($fileId)."?fields=id,name,mimeType,size";
        $meta = hget($metaUrl, ["Authorization: Bearer $tok"]);
        if (!$meta) return ['ok'=>false,'error'=>'Sem resposta dos metadados.'.hLastError()];
        $m = json_decode($meta, true);
        if (isset($m['error'])) return ['ok'=>false,'error'=>'Drive: '.($m['error']['message']??'desconhecido')];
        if (empty($m['name'])) return ['ok'=>false,'error'=>'Arquivo não encontrado.'];
        // Timeout estendido para acomodar vídeos com payloads grandes.
        $url = "https://www.googleapis.com/drive/v3/files/".urlencode($fileId)."?alt=media";
        $ctx = stream_context_create(['http'=>[
            'method'        => 'GET',
            'header'        => "Authorization: Bearer $tok\r\n",
            'timeout'       => 60,
            'ignore_errors' => true,
        ]]);
        $data = @file_get_contents($url, false, $ctx);
        if ($data === false || $data === '') return ['ok'=>false,'error'=>'Falha ao baixar o conteúdo.'];
        return [
            'ok'   => true,
            'data' => $data,
            'name' => $m['name'],
            'mime' => $m['mimeType'] ?? 'application/octet-stream',
        ];
    }

    public function getDriveNewFiles(int $days=7): array {
        $tok=$this->getToken();
        $folderIds=$this->getAllFolderIds();
        $parents=implode(' or ',array_map(fn($id)=>"'$id' in parents",$folderIds));
        $after=date('c',strtotime("-{$days} days"));
        $q=urlencode("($parents) and createdTime>'$after' and trashed=false and mimeType!='application/vnd.google-apps.folder'");
        $resp=hget("https://www.googleapis.com/drive/v3/files?q=$q&fields=files(id,name)&pageSize=50",["Authorization: Bearer $tok"]);
        if (!$resp) return [];
        return json_decode($resp,true)['files']??[];
    }
}

/**
 * Codifica em base64 url-safe (RFC 4648 §5), removendo padding.
 * Utilizada na composição do JWT enviado ao endpoint OAuth do Google.
 */
function b64u(string $d):string{return rtrim(strtr(base64_encode($d),'+/','-_'),'=');}

/* Detalhe do último erro de transporte HTTP (timeout, DNS, TLS, conexão
   recusada). As funções h* retornam null em falha; o motivo real fica
   acessível via hLastError() para compor mensagens de erro que apontem a
   causa em vez de um "sem resposta" genérico. */
function hSetLastError(): void {
    $e = error_get_last();
    $GLOBALS['H_LAST_HTTP_ERROR'] = trim((string)($e['message'] ?? 'erro de transporte desconhecido'));
}
function hLastError(): string {
    $m = $GLOBALS['H_LAST_HTTP_ERROR'] ?? '';
    return $m !== '' ? ' ['.$m.']' : '';
}

/** Helper de requisição HTTP GET via stream wrappers; retorna null em falha. */
function hget(string $url,array $h=[]):?string{$ctx=stream_context_create(['http'=>['method'=>'GET','header'=>implode("\r\n",$h),'timeout'=>15,'ignore_errors'=>true]]);error_clear_last();$r=@file_get_contents($url,false,$ctx);if($r===false)hSetLastError();return $r===false?null:$r;}

/** Helper de requisição HTTP POST via stream wrappers; retorna null em falha. */
function hpost(string $url,string $body,array $h=[]):?string{$ctx=stream_context_create(['http'=>['method'=>'POST','header'=>implode("\r\n",$h),'content'=>$body,'timeout'=>15,'ignore_errors'=>true]]);error_clear_last();$r=@file_get_contents($url,false,$ctx);if($r===false)hSetLastError();return $r===false?null:$r;}

/** Helper de requisição HTTP PUT via stream wrappers; retorna null em falha. */
function hput(string $url,string $body,array $h=[]):?string{$ctx=stream_context_create(['http'=>['method'=>'PUT','header'=>implode("\r\n",$h),'content'=>$body,'timeout'=>20,'ignore_errors'=>true]]);error_clear_last();$r=@file_get_contents($url,false,$ctx);if($r===false)hSetLastError();return $r===false?null:$r;}
