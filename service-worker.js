/* =========================================================
   service-worker.js
   方針：
   - fetch は Cache Only（ネットワークには基本問い合わせない）
   - install で skipWaiting しない（手動更新のため）
   - 更新検知後、ページから SKIP_WAITING が来た時だけ skipWaiting する
   - キャッシュ保存は Promise.allSettled で個別に行い、1ファイル失敗で全滅させない
   - 各ファイル取得は最大3回リトライ（'no-store' とデフォルトを交互に使用）
   - キャッシュキーは new URL(path, self.location).href で完全URL化
   ========================================================= */

// ファイル更新のたびにこの番号を必ず上げる
const CACHE_NAME = 'omikuji-cache-v2';

// 実在するファイル名と完全一致させること（service-worker.js自体は含めない）
const ASSETS = [
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png'
];

// 直近のキャッシュ取得結果（診断パネル用）。Cache Storageに保存して再起動後も読めるようにする
const REPORT_URL = new URL('__sw_report__', self.location).href;

function toAbsoluteUrl(path) {
  return new URL(path, self.location).href;
}

// 1ファイルを最大3回リトライしながら取得する。
// 'no-store' とデフォルトの cache オプションを交互に試す（モバイル端末での不安定さ対策）
async function fetchWithRetry(absUrl, maxRetries = 3) {
  let lastError = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const cacheOption = attempt % 2 === 0 ? 'no-store' : 'default';
    try {
      const res = await fetch(absUrl, { cache: cacheOption });
      if (res && (res.ok || res.type === 'opaque')) {
        return res;
      }
      lastError = new Error('HTTPステータス: ' + (res ? res.status : '不明'));
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('不明な取得エラー');
}

// 直近レポートを Cache Storage に保存する（SW終了後も診断パネルから読めるようにするため）
async function saveReport(report) {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(
      REPORT_URL,
      new Response(JSON.stringify(report), {
        headers: { 'Content-Type': 'application/json' }
      })
    );
  } catch (e) {
    // レポート保存自体の失敗は握りつぶす（本体キャッシュ処理を優先）
  }
}

async function loadReport() {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(REPORT_URL);
    if (!res) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

// ASSETS全件を個別にキャッシュする（cache.addAllは使わない）
async function cacheAssets() {
  const cache = await caches.open(CACHE_NAME);

  const settled = await Promise.allSettled(
    ASSETS.map(async (path) => {
      const absUrl = toAbsoluteUrl(path);
      const res = await fetchWithRetry(absUrl, 3);
      await cache.put(absUrl, res.clone());
      return absUrl;
    })
  );

  const succeeded = [];
  const failed = [];
  settled.forEach((result, i) => {
    const absUrl = toAbsoluteUrl(ASSETS[i]);
    if (result.status === 'fulfilled') {
      succeeded.push(absUrl);
    } else {
      failed.push({
        url: absUrl,
        reason: result.reason ? String(result.reason.message || result.reason) : '不明なエラー'
      });
    }
  });

  const report = {
    time: Date.now(),
    cacheName: CACHE_NAME,
    expected: ASSETS.length,
    succeeded,
    failed
  };
  await saveReport(report);
  return report;
}

// --- install: キャッシュを作るだけ。skipWaitingは絶対に呼ばない ---
self.addEventListener('install', (event) => {
  event.waitUntil(cacheAssets());
});

// --- activate: 古いバージョンのキャッシュだけ削除し、制御を引き継ぐ ---
// （これはskipWaiting後にしか起こらないため「自動更新」ではない）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// --- fetch: Cache Only。ネットワークには問い合わせない ---
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET以外、http/https以外のリクエストはスルーする（ブラウザのデフォルト処理に任せる）
  if (req.method !== 'GET' || !req.url.startsWith('http')) {
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      // ナビゲーション要求はindex.htmlのキャッシュを最優先で返す
      if (req.mode === 'navigate') {
        const indexRes = await cache.match(toAbsoluteUrl('index.html'));
        if (indexRes) return indexRes;
      }

      const cached = await cache.match(req);
      if (cached) return cached;

      // Cache Onlyのため、未キャッシュ時もネットワークへは問い合わせない
      return new Response(
        'オフラインのためこのリソースは利用できません（未キャッシュ）',
        { status: 504, statusText: 'Offline - Not Cached' }
      );
    })()
  );
});

// --- message: ページからの指示にのみ反応する ---
self.addEventListener('message', (event) => {
  const data = event.data || {};

  if (data.type === 'SKIP_WAITING') {
    // 「更新する」を押した時だけ呼ばれる
    self.skipWaiting();
    return;
  }

  if (data.type === 'CACHE_NOW') {
    // 診断パネルの「キャッシュを今すぐ手動で再取得する」ボタンから呼ばれる
    event.waitUntil(
      cacheAssets().then((report) => {
        return broadcast({ type: 'CACHE_REPORT', report });
      })
    );
    return;
  }

  if (data.type === 'GET_STATUS') {
    event.waitUntil(sendStatus(event.source));
    return;
  }
});

async function broadcast(message) {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true });
  clientsList.forEach((c) => c.postMessage(message));
}

async function sendStatus(client) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  const expectedUrls = ASSETS.map(toAbsoluteUrl);
  const cachedUrls = keys.map((k) => k.url).filter((u) => u !== REPORT_URL);
  const cachedExpectedCount = cachedUrls.filter((u) => expectedUrls.includes(u)).length;
  const lastReport = await loadReport();

  const status = {
    type: 'STATUS',
    cacheName: CACHE_NAME,
    expectedCount: expectedUrls.length,
    cachedCount: cachedExpectedCount,
    cachedUrls,
    lastReport
  };

  if (client && client.postMessage) {
    client.postMessage(status);
  } else {
    await broadcast(status);
  }
}
