/**
 * mimo-proxy-worker.js — 小米 MiMo API 代理（Cloudflare Worker）
 *
 * 作用：把 API Key 从「前端页面」移到「Worker 环境变量」，
 *       使 index.html 源码中完全不含任何密钥。
 *
 * 部署后把 index.html 顶部的 AI_BASE_URL（APP.aiBaseUrl）改为：
 *   https://<你的-worker-域名>
 * 并去掉路径中的 /v1/chat/completions —— 前端会自行拼接 /chat/completions。
 *
 * 即：aiBaseUrl 设为 https://<worker>.workers.dev/v1
 *
 * 安全能力：
 *   1. Origin 白名单（只允许你的课程站点调用）
 *   2. 单 IP 频率限制（滑动窗口）
 *   3. 请求体大小上限
 *   4. 用量日志（含来源、时间、token 使用量）
 *   5. 只放行 /v1/chat/completions，其它路径一律 404
 */

const ALLOWED_ORIGINS = [
  'https://ruanqiaoyun0-a11y.github.io',
  'http://localhost:8123',
  'http://127.0.0.1:8123',
];

const UPSTREAM = 'https://api.xiaomimimo.com/v1/chat/completions';
const ALLOWED_MODEL = 'mimo-v2.5-pro';

const RATE_LIMIT_MAX = 60;          // 每个 IP 每窗口最大请求数
const RATE_LIMIT_WINDOW_MS = 3600000; // 1 小时
const MAX_BODY_BYTES = 200 * 1024;  // 请求体上限 200KB

// 内存级限流（Worker 实例级；如需跨实例精确限流请改用 Durable Object 或 KV）
const hits = new Map();

function rateLimit(key) {
  const now = Date.now();
  let arr = (hits.get(key) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (arr.length >= RATE_LIMIT_MAX) {
    hits.set(key, arr);
    const resetIn = Math.ceil((arr[0] + RATE_LIMIT_WINDOW_MS - now) / 60000);
    return { ok: false, resetIn };
  }
  arr.push(now);
  hits.set(key, arr);
  // 防止 Map 无限增长
  if (hits.size > 5000) hits.clear();
  return { ok: true, used: arr.length };
}

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';

    // 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return json({ error: { message: 'Method Not Allowed' } }, 405, origin);
    }

    // 只放行这一条路径
    if (!url.pathname.endsWith('/v1/chat/completions') && url.pathname !== '/v1/chat/completions') {
      return json({ error: { message: 'Not Found' } }, 404, origin);
    }

    // Origin 白名单
    if (origin && ALLOWED_ORIGINS.indexOf(origin) === -1) {
      return json({ error: { message: 'Forbidden origin' } }, 403, origin);
    }

    // 密钥
    const key = env.MIMO_API_KEY;
    if (!key) {
      return json({ error: { message: 'Server not configured: missing MIMO_API_KEY' } }, 500, origin);
    }

    // 限流
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rl = rateLimit(ip);
    if (!rl.ok) {
      return json({ error: { message: '请求过于频繁，约 ' + rl.resetIn + ' 分钟后恢复' } }, 429, origin);
    }

    // 体积检查
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) {
      return json({ error: { message: 'Payload too large' } }, 413, origin);
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return json({ error: { message: 'Invalid JSON' } }, 400, origin);
    }

    // 模型白名单 + 强制参数，避免被当成通用代理滥用
    body.model = ALLOWED_MODEL;
    if (!body.thinking) body.thinking = { type: 'disabled' };
    if (body.max_tokens && !body.max_completion_tokens) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }

    const started = Date.now();
    let upstream;
    try {
      upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + key,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json({ error: { message: 'Upstream unreachable' } }, 502, origin);
    }

    const text = await upstream.text();
    let usage = null;
    try { usage = JSON.parse(text).usage || null; } catch (e) {}

    // 用量日志（不含任何密钥信息）
    ctx.waitUntil(Promise.resolve(console.log(JSON.stringify({
      t: new Date().toISOString(),
      ip,
      origin,
      status: upstream.status,
      ms: Date.now() - started,
      used: rl.used,
      tokens: usage,
    }))));

    return new Response(text, {
      status: upstream.status,
      headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
    });
  },
};

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json' }, corsHeaders(origin)),
  });
}
