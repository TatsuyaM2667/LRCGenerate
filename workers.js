/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  LRC Studio — Cloudflare R2 Proxy Worker                    ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * エンドポイント一覧:
 *   GET    /music_index.json          → music_index.json を返す
 *   GET    /stream?path=/1.0.mp3      → R2 オブジェクトをストリーム
 *   OPTIONS *                         → CORS プリフライト
 *   PUT    /upload?path=/1.0.mp3      → R2 にファイルをアップロード
 *   DELETE /delete?path=/1.0.mp3      → R2 からファイルを削除
 *   POST   /update_index              → music_index.json を更新
 *   GET    /list                       → R2 内の全オブジェクトキー一覧
 */

const ALLOWED_ORIGIN = "*";

const CACHE_TTL_INDEX  = 60;
const CACHE_TTL_AUDIO  = 3600;
const CACHE_TTL_IMAGE  = 86400;
const CACHE_TTL_LRC    = 300;

const MIME = {
  mp3:  "audio/mpeg",
  m4a:  "audio/mp4",
  flac: "audio/flac",
  ogg:  "audio/ogg",
  aac:  "audio/aac",
  wav:  "audio/wav",
  lrc:  "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  jpg:  "image/jpeg",
  jpeg: "image/jpeg",
  png:  "image/png",
  webp: "image/webp",
  gif:  "image/gif",
  mp4:  "video/mp4",
  webm: "video/webm",
};

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();

    // CORS プリフライト
    if (method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    try {
      // ── PUT /upload?path=... ────────────────────────────────
      if (method === "PUT" && url.pathname === "/upload") {
        return await handleUpload(url, request, env);
      }

      // ── DELETE /delete?path=... ─────────────────────────────
      if (method === "DELETE" && url.pathname === "/delete") {
        return await handleDelete(url, env);
      }

      // ── POST /update_index ──────────────────────────────────
      if (method === "POST" && url.pathname === "/update_index") {
        return await handleUpdateIndex(request, env);
      }

      // GET のみ以降
      if (method !== "GET" && method !== "HEAD") {
        return corsResponse(new Response("Method Not Allowed", { status: 405 }));
      }

      // ── ルーティング (GET) ──────────────────────────────────
      if (url.pathname === "/stream") {
        const filePath = url.searchParams.get("path");
        if (!filePath) return corsResponse(new Response("Missing ?path parameter", { status: 400 }));
        return await serveR2Object(filePath, request, env, ctx);
      }

      if (url.pathname === "/music_index.json") {
        return await serveR2Object("/music_index.json", request, env, ctx);
      }

      // ── GET /list?type=audio|lrc|all ────────────────────────
      if (url.pathname === "/list") {
        return await handleList(env, url);
      }

      if (url.pathname !== "/") {
        return await serveR2Object(url.pathname, request, env, ctx);
      }

      return corsResponse(new Response(
        JSON.stringify({ status: "ok", service: "LRC Studio R2 Proxy" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      ));

    } catch (err) {
      console.error("Worker error:", err);
      return corsResponse(new Response(
        JSON.stringify({ error: err.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      ));
    }
  }
};

// ───────────────────────────────────────────────────────────────
//  PUT /upload?path=/foo/bar.mp3
//  Body: 生バイナリ  (Content-Type はクライアントが設定)
// ───────────────────────────────────────────────────────────────
async function handleUpload(url, request, env) {
  const filePath = url.searchParams.get("path");
  if (!filePath) return corsResponse(new Response("Missing ?path", { status: 400 }));

  const key = filePath.replace(/^\/+/, "");
  if (!key) return corsResponse(new Response("Invalid path", { status: 400 }));

  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  const body = await request.arrayBuffer();

  await env.MUSIC_BUCKET.put(key, body, {
    httpMetadata: { contentType }
  });

  return corsResponse(new Response(
    JSON.stringify({ ok: true, path: "/" + key, size: body.byteLength }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
}

// ───────────────────────────────────────────────────────────────
//  DELETE /delete?path=/foo/bar.mp3
// ───────────────────────────────────────────────────────────────
async function handleDelete(url, env) {
  const filePath = url.searchParams.get("path");
  if (!filePath) return corsResponse(new Response("Missing ?path", { status: 400 }));

  const key = filePath.replace(/^\/+/, "");
  if (!key) return corsResponse(new Response("Invalid path", { status: 400 }));

  await env.MUSIC_BUCKET.delete(key);

  return corsResponse(new Response(
    JSON.stringify({ ok: true, path: "/" + key }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
}

// ───────────────────────────────────────────────────────────────
//  GET /list → R2 内の全オブジェクトキー一覧（音声ファイルのみ）
// ───────────────────────────────────────────────────────────────
async function handleList(env, url) {
  const type = url.searchParams.get('type') || 'audio';
  const AUDIO_EXT = new Set(['mp3','m4a','flac','ogg','aac','wav']);
  const LRC_EXT   = new Set(['lrc']);

  const keys = [];
  let cursor;
  do {
    const opts = cursor ? { cursor, limit: 1000 } : { limit: 1000 };
    const result = await env.MUSIC_BUCKET.list(opts);
    for (const obj of result.objects) {
      const ext = obj.key.split('.').pop()?.toLowerCase() ?? '';
      const isAudio = AUDIO_EXT.has(ext);
      const isLrc   = LRC_EXT.has(ext);
      if (type === 'lrc'   && isLrc)   keys.push('/' + obj.key);
      if (type === 'audio' && isAudio) keys.push({ path: '/' + obj.key, size: obj.size });
      if (type === 'all'   && (isAudio || isLrc)) keys.push('/' + obj.key);
    }
    cursor = result.truncated ? result.cursor : null;
  } while (cursor);

  return corsResponse(new Response(
    JSON.stringify(keys),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  ));
}

// ───────────────────────────────────────────────────────────────
//  POST /update_index
//  Body: JSON 配列 (music_index.json の内容をそのまま)
// ───────────────────────────────────────────────────────────────
async function handleUpdateIndex(request, env) {
  let body;
  try {
    body = await request.text();
    JSON.parse(body); // バリデーション
  } catch (e) {
    return corsResponse(new Response("Invalid JSON", { status: 400 }));
  }

  await env.MUSIC_BUCKET.put("music_index.json", body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" }
  });

  // キャッシュ無効化（次のGETでMISSさせる）
  try {
    const cacheKey = new Request(new URL("/cache/music_index.json", "https://dummy.invalid").toString());
    await caches.default.delete(cacheKey);
  } catch (e) { /* ignore */ }

  return corsResponse(new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  ));
}

// ───────────────────────────────────────────────────────────────
//  R2 オブジェクト取得 & レスポンス生成
// ───────────────────────────────────────────────────────────────
async function serveR2Object(filePath, request, env, ctx) {
  const key = filePath.replace(/^\/+/, "");
  if (!key) return corsResponse(new Response("Invalid path", { status: 400 }));

  const cacheKey = new Request(new URL("/cache/" + key, request.url).toString());
  const cache    = caches.default;

  let cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    headers.set("X-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const range  = request.headers.get("Range");
  const r2Opts = range ? { range: parseRange(range) } : {};

  let obj;
  try {
    obj = range
      ? await env.MUSIC_BUCKET.get(key, r2Opts)
      : await env.MUSIC_BUCKET.get(key);
  } catch (e) {
    return corsResponse(new Response("R2 fetch error: " + e.message, { status: 502 }));
  }

  if (!obj) {
    return corsResponse(new Response(`Not found: ${key}`, { status: 404 }));
  }

  const ext      = key.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = obj.httpMetadata?.contentType || MIME[ext] || "application/octet-stream";

  let ttl = CACHE_TTL_AUDIO;
  if (ext === "json")                              ttl = CACHE_TTL_INDEX;
  else if (ext === "lrc")                          ttl = CACHE_TTL_LRC;
  else if (["jpg","jpeg","png","webp","gif"].includes(ext)) ttl = CACHE_TTL_IMAGE;

  const headers = new Headers({
    "Content-Type"                 : mimeType,
    "Access-Control-Allow-Origin"  : ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods" : "GET, OPTIONS",
    "Access-Control-Allow-Headers" : "Range, Content-Type",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
    "Cache-Control"                : `public, max-age=${ttl}`,
    "Accept-Ranges"                : "bytes",
    "X-Cache"                      : "MISS",
    "ETag"                         : obj.httpEtag || `"${key}"`,
  });

  if (obj.size) headers.set("Content-Length", String(obj.size));

  if (range && obj.range) {
    const { offset, length } = obj.range;
    const total = obj.size ?? "*";
    const end   = offset + length - 1;
    headers.set("Content-Range", `bytes ${offset}-${end}/${total}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  const response = new Response(obj.body, { status: 200, headers });

  const skipCache = ["mp3","m4a","flac","ogg","aac","wav","mp4","webm"].includes(ext);
  if (!skipCache) {
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
  }

  return response;
}

// ───────────────────────────────────────────────────────────────
//  ユーティリティ
// ───────────────────────────────────────────────────────────────
function parseRange(rangeHeader) {
  const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
  if (!m) return undefined;
  const offset = parseInt(m[1]);
  const end    = m[2] ? parseInt(m[2]) : undefined;
  return end !== undefined
    ? { offset, length: end - offset + 1 }
    : { offset, suffix: undefined };
}

function corsResponse(response, status) {
  if (response === null) {
    return new Response(null, {
      status: status || 204,
      headers: {
        "Access-Control-Allow-Origin" : ALLOWED_ORIGIN,
        "Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Range, Content-Type",
        "Access-Control-Max-Age"      : "86400",
      }
    });
  }
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin",  ALLOWED_ORIGIN);
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, PUT, DELETE, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Range, Content-Type");
  return new Response(response.body, { status: response.status || status, headers });
}
