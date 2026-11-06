<?php
declare(strict_types=1);

$action = $_GET['action'] ?? '';
$cacheRoot = __DIR__ . '/.cache';
$timelineDir = $cacheRoot . '/timelines';
$snapshotDir = $cacheRoot . '/snapshots';

if (!is_dir($timelineDir)) @mkdir($timelineDir, 0755, true);
if (!is_dir($snapshotDir)) @mkdir($snapshotDir, 0755, true);
if (!file_exists($cacheRoot . '/.htaccess')) {
    @file_put_contents($cacheRoot . '/.htaccess', "Require all denied\n");
}

header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, Accept');
header('content-signal: ai-train=yes, search=yes, ai-input=yes');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}

function sha1_short(string $s): string {
    return substr(sha1($s), 0, 16);
}

function normalize_target_url(string $raw): ?array {
    $s = trim($raw);
    if ($s === '') return null;
    if (preg_match('~web\.archive\.org/web/\d+(?:[a-z]+_)?/(https?://.+)$~i', $s, $m)) {
        $s = $m[1];
    }
    if (!preg_match('~^https?://~i', $s)) {
        $s = 'https://' . $s;
    }
    $parts = parse_url($s);
    if (!$parts || empty($parts['host']) || strpos($parts['host'], '.') === false) {
        return null;
    }
    $host = strtolower(preg_replace('~^www\.~i', '', $parts['host']));
    if (!preg_match('~^[a-z0-9.-]+$~', $host)) {
        return null;
    }
    $path = $parts['path'] ?? '/';
    $cleanPath = ($path === '/') ? '' : rtrim($path, '/');
    return [
        'domain' => $host,
        'lookupKey' => $host . $cleanPath,
        'fullUrl' => 'https://' . $host . ($cleanPath ?: '/'),
    ];
}

function format_wb_ts(string $ts): array {
    $months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    $year = (int)substr($ts, 0, 4);
    $mIdx = max(0, min(11, ((int)substr($ts, 4, 2)) - 1));
    $day = substr($ts, 6, 2) ?: '01';
    $mon = substr($ts, 4, 2) ?: '01';
    return [
        'year' => $year,
        'dateLabel' => "{$day} {$months[$mIdx]} {$year}",
        'isoDate' => "{$year}-{$mon}-{$day}",
    ];
}

function curl_get(string $url, int $timeout = 14, array $headers = []): array {
    $ch = curl_init($url);
    $baseHeaders = array_merge([
        'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    ], $headers);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 4,
        CURLOPT_CONNECTTIMEOUT => 6,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HTTPHEADER => $baseHeaders,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);
    return ['code' => $code, 'type' => $ctype, 'body' => is_string($body) ? $body : ''];
}

if ($action === 'markdown') {
    $mdBody = @file_get_contents(__DIR__ . '/llms.txt') ?: "# Wayback Reel\n";
    $htmlRaw = @file_get_contents(__DIR__ . '/index.html') ?: '';
    $frontmatter = "---\n"
        . "title: \"Wayback Reel — Yearly Website Snapshots to MP4 in Browser\"\n"
        . "description: \"Captures one Wayback Machine snapshot per archived year for any website and encodes an H.264 MP4 time-lapse in the browser with FFmpeg WebAssembly.\"\n"
        . "url: \"https://h3manth.com/fun/wayback-to-video/\"\n"
        . "---\n\n";
    $fullMd = $frontmatter . $mdBody;
    header('Content-Type: text/markdown; charset=utf-8');
    header('Vary: Accept');
    header('x-markdown-tokens: ' . (string)(int)ceil(strlen($fullMd) / 4));
    if ($htmlRaw !== '') {
        header('x-original-tokens: ' . (string)(int)ceil(strlen($htmlRaw) / 4));
    }
    echo $fullMd;
    exit;
}

if ($action === 'timeline') {
    header('Content-Type: application/json; charset=utf-8');
    $parsed = normalize_target_url((string)($_GET['url'] ?? ''));
    if (!$parsed) {
        http_response_code(400);
        echo json_encode(['error' => 'Enter a valid website domain (e.g. apple.com)']);
        exit;
    }

    $lookupKey = $parsed['lookupKey'];
    $cacheFile = $timelineDir . '/' . sha1_short($lookupKey) . '.json';
    if (is_file($cacheFile) && (time() - filemtime($cacheFile) < 86400)) {
        $cached = @file_get_contents($cacheFile);
        if ($cached) {
            $snapshots = json_decode($cached, true);
            if (is_array($snapshots) && count($snapshots) > 0) {
                header('Cache-Control: public, max-age=3600');
                echo json_encode([
                    'domain' => $parsed['domain'],
                    'lookupKey' => $lookupKey,
                    'count' => count($snapshots),
                    'snapshots' => $snapshots,
                ]);
                exit;
            }
        }
    }

    $byYear = [];
    $maxYear = (int)date('Y');
    $cdxUrl = 'https://web.archive.org/cdx/search/cdx?url=' . rawurlencode($lookupKey)
        . '&output=json&fl=timestamp,original,statuscode,mimetype'
        . '&filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:4';

    $res = curl_get($cdxUrl, 15, ['Accept: application/json']);
    if ($res['code'] === 200 && $res['body'] !== '') {
        $rows = json_decode($res['body'], true);
        if (is_array($rows) && count($rows) > 1) {
            for ($i = 1; $i < count($rows); $i++) {
                $ts = (string)($rows[$i][0] ?? '');
                $orig = (string)($rows[$i][1] ?? ('http://' . $lookupKey . '/'));
                if (strlen($ts) < 8) continue;
                $fmt = format_wb_ts($ts);
                $y = $fmt['year'];
                if ($y >= 1995 && $y <= $maxYear && !isset($byYear[$y])) {
                    $byYear[$y] = [
                        'year' => $y,
                        'timestamp' => $ts,
                        'dateLabel' => $fmt['dateLabel'],
                        'isoDate' => $fmt['isoDate'],
                        'originalUrl' => $orig,
                        'archiveUrl' => "https://web.archive.org/web/{$ts}/{$orig}",
                        'iframeUrl' => "https://web.archive.org/web/{$ts}if_/{$orig}",
                    ];
                }
            }
        }
    }

    // Fallback via Sparkline + Availability API if CDX timed out
    if (empty($byYear)) {
        $years = [];
        $spark = curl_get(
            'https://web.archive.org/__wb/sparkline?output=json&url=' . rawurlencode($lookupKey) . '&collection=web',
            8,
            ['Referer: https://web.archive.org/', 'Accept: application/json']
        );
        if ($spark['code'] === 200) {
            $sj = json_decode($spark['body'], true);
            if (!empty($sj['years']) && is_array($sj['years'])) {
                foreach ($sj['years'] as $yr => $months) {
                    $yi = (int)$yr;
                    if ($yi >= 1995 && $yi <= $maxYear && is_array($months) && array_sum($months) > 0) {
                        $years[] = $yi;
                    }
                }
                sort($years);
            }
        }
        if (empty($years)) {
            for ($y = 1998; $y <= $maxYear; $y += 2) $years[] = $y;
        }

        // Batch curl_multi in chunks of 6
        foreach (array_chunk($years, 6) as $chunk) {
            $mh = curl_multi_init();
            $handles = [];
            foreach ($chunk as $y) {
                $u = 'https://archive.org/wayback/available?url=' . rawurlencode($lookupKey) . "&timestamp={$y}0615";
                $ch = curl_init($u);
                curl_setopt_array($ch, [
                    CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 8,
                    CURLOPT_CONNECTTIMEOUT => 4,
                    CURLOPT_USERAGENT => 'Mozilla/5.0',
                ]);
                curl_multi_add_handle($mh, $ch);
                $handles[$y] = $ch;
            }
            do {
                $status = curl_multi_exec($mh, $active);
                if ($active) curl_multi_select($mh, 0.5);
            } while ($active && $status === CURLM_OK);

            foreach ($handles as $y => $ch) {
                $body = curl_multi_getcontent($ch);
                if ($body) {
                    $av = json_decode($body, true);
                    $closest = $av['archived_snapshots']['closest'] ?? null;
                    if (!empty($closest['available']) && !empty($closest['timestamp'])) {
                        $ts = (string)$closest['timestamp'];
                        $fmt = format_wb_ts($ts);
                        if ($fmt['year'] === $y && !isset($byYear[$y])) {
                            $orig = 'http://' . $lookupKey . '/';
                            $byYear[$y] = [
                                'year' => $y,
                                'timestamp' => $ts,
                                'dateLabel' => $fmt['dateLabel'],
                                'isoDate' => $fmt['isoDate'],
                                'originalUrl' => $orig,
                                'archiveUrl' => "https://web.archive.org/web/{$ts}/{$orig}",
                                'iframeUrl' => "https://web.archive.org/web/{$ts}if_/{$orig}",
                            ];
                        }
                    }
                }
                curl_multi_remove_handle($mh, $ch);
                curl_close($ch);
            }
            curl_multi_close($mh);
        }
    }

    ksort($byYear);
    $snapshots = array_values($byYear);
    if (!empty($snapshots)) {
        @file_put_contents($cacheFile, json_encode($snapshots, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
    }

    header('Cache-Control: public, max-age=3600');
    echo json_encode([
        'domain' => $parsed['domain'],
        'lookupKey' => $lookupKey,
        'count' => count($snapshots),
        'snapshots' => $snapshots,
    ], JSON_UNESCAPED_SLASHES);
    exit;
}

if ($action === 'snapshot') {
    $ts = preg_replace('~\D~', '', (string)($_GET['timestamp'] ?? ''));
    $target = trim((string)($_GET['url'] ?? ''));
    if (strlen($ts) < 8 || !preg_match('~^https?://~i', $target)) {
        http_response_code(400);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['error' => 'Invalid timestamp or url']);
        exit;
    }

    $key = $ts . '_' . sha1_short($target);
    $jpgPath = $snapshotDir . '/' . $key . '.jpg';
    $pngPath = $snapshotDir . '/' . $key . '.png';

    foreach ([[$jpgPath, 'image/jpeg'], [$pngPath, 'image/png']] as [$p, $mime]) {
        if (is_file($p) && filesize($p) > 2000) {
            header('Content-Type: ' . $mime);
            header('Content-Length: ' . (string)filesize($p));
            header('Cross-Origin-Resource-Policy: cross-origin');
            header('Cache-Control: public, max-age=604800, immutable');
            readfile($p);
            exit;
        }
    }

    $iframeUrl = "https://web.archive.org/web/{$ts}if_/{$target}";

    // Provider 1: thum.io (direct 1280x800 capture)
    $thum = curl_get("https://image.thum.io/get/width/1280/crop/800/noanimate/{$iframeUrl}", 18);
    if ($thum['code'] === 200 && strpos($thum['type'], 'image/') === 0 && strlen($thum['body']) > 3500) {
        $isPng = (substr($thum['body'], 0, 4) === "\x89PNG");
        $savePath = $isPng ? $pngPath : $jpgPath;
        $mime = $isPng ? 'image/png' : 'image/jpeg';
        @file_put_contents($savePath, $thum['body']);
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . (string)strlen($thum['body']));
        header('Cross-Origin-Resource-Policy: cross-origin');
        header('Cache-Control: public, max-age=604800, immutable');
        echo $thum['body'];
        exit;
    }

    // Provider 2: Microlink screenshot fallback
    $ml = curl_get('https://api.microlink.io/?url=' . rawurlencode($iframeUrl) . '&screenshot=true&meta=false', 18, ['Accept: application/json']);
    if ($ml['code'] === 200 && $ml['body'] !== '') {
        $mj = json_decode($ml['body'], true);
        $shotUrl = $mj['data']['screenshot']['url'] ?? '';
        if ($shotUrl !== '') {
            $img = curl_get($shotUrl, 15);
            if ($img['code'] === 200 && strlen($img['body']) > 3500) {
                $isPng = (substr($img['body'], 0, 4) === "\x89PNG");
                $savePath = $isPng ? $pngPath : $jpgPath;
                $mime = $isPng ? 'image/png' : 'image/jpeg';
                @file_put_contents($savePath, $img['body']);
                header('Content-Type: ' . $mime);
                header('Content-Length: ' . (string)strlen($img['body']));
                header('Cross-Origin-Resource-Policy: cross-origin');
                header('Cache-Control: public, max-age=604800, immutable');
                echo $img['body'];
                exit;
            }
        }
    }

    http_response_code(502);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['error' => 'Snapshot unavailable']);
    exit;
}

http_response_code(404);
header('Content-Type: application/json; charset=utf-8');
echo json_encode(['error' => 'Unknown endpoint']);
