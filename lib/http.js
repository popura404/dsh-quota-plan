import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { pricingModels } from './pricing.js';

export const BASE_PATH = '/_dsh/quota-plan';
const assets = new Map([
  [BASE_PATH, ['index.html', 'text/html; charset=utf-8']],
  [BASE_PATH + '/', ['index.html', 'text/html; charset=utf-8']],
  [BASE_PATH + '/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  [BASE_PATH + '/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'";

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}
async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new Error('请求内容超过 64KB');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isLoopbackHost(host) {
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch { return false; }
}

export function createHttpHandler({ store, limiter, connection }) {
  const status = () => {
    const snap = store.status();
    const diagnostics = limiter?.diagnostics() ?? {};
    return {
      ...snap, pricingModels: pricingModels(snap.config), version: '0.1.1',
      integration: { hook: 'llm/stream', reservation: 'model-context-upper-bound',
        pricing: '官方高峰价或手动单价', ...diagnostics },
    };
  };
  const handler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', CSP);
    const path = new URL(req.url, 'http://localhost').pathname;
    if (connection) {
      const rejection = connection.requestRejection(req);
      if (rejection === 403) return json(res, 403, { error: '请求来源不受信任' });
      if (assets.has(path) && (path === BASE_PATH || path === BASE_PATH + '/')) {
        if (!connection.authorizeIndex(req, res)) return;
      } else if (rejection) return json(res, rejection, { error: '请先在 DSH 中登录此本地服务' });
    } else {
      if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: '只允许本机请求' });
      if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) {
        return json(res, 403, { error: '请求来源不受信任' });
      }
    }
    try {
      if (req.method === 'GET' && path === BASE_PATH + '/api/status') return json(res, 200, status());
      if (req.method === 'POST' && path.startsWith(BASE_PATH + '/api/')) {
        if (req.headers['x-dsh-quota'] !== '1' || !req.headers['content-type']?.startsWith('application/json')) {
          return json(res, 403, { error: '请求缺少额度页面验证标识' });
        }
        const payload = await body(req);
        if (path === BASE_PATH + '/api/config') {
          store.configure(payload);
          return json(res, 200, status());
        }

      }
      if ((req.method === 'GET' || req.method === 'HEAD') && assets.has(path)) {
        const [file, type] = assets.get(path);
        res.setHeader('Content-Type', type);
        const contents = readFileSync(fileURLToPath(new URL(`../gui/${file}`, import.meta.url)));
        res.end(req.method === 'HEAD' ? undefined : contents);
        return;
      }
      return json(res, 404, { error: '页面不存在' });
    } catch (e) { return json(res, 400, { error: e.message }); }
  };
  return { handler, status };
}
