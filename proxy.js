// proxy.js (REST/WS split-proxy)
// Run normally (no local proxy):                     node proxy.js
// REST via local proxy, WS direct (recommended):     BINANCE_USE_PROXY_REST=1 BINANCE_USE_PROXY_WS=0 node proxy.js
// Both direct (no proxy):                            BINANCE_USE_PROXY_REST=0 BINANCE_USE_PROXY_WS=0 node proxy.js
// Both via local proxy (not recommended for WS):     BINANCE_USE_PROXY_REST=1 BINANCE_USE_PROXY_WS=1 node proxy.js
// Custom port:                                       PORT=8080 node proxy.js

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { HttpsProxyAgent } from 'https-proxy-agent';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- 可选：分别控制 REST 与 WS 是否走本地代理（例如 Clash）----
// 默认：REST 不走，WS 不走（更稳定）。按需用环境变量开启。
const USE_LOCAL_PROXY_REST = process.env.BINANCE_USE_PROXY_REST === '1';
const USE_LOCAL_PROXY_WS = process.env.BINANCE_USE_PROXY_WS === '1';

const LOCAL_PROXY =
    process.env.HTTP_PROXY ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.https_proxy ||
    'http://127.0.0.1:7890';
const restAgent = USE_LOCAL_PROXY_REST ? new HttpsProxyAgent(LOCAL_PROXY) : undefined;
const wsAgent = USE_LOCAL_PROXY_WS ? new HttpsProxyAgent(LOCAL_PROXY) : undefined;

console.log(`[BOOT] REST via proxy = ${!!restAgent}, WS via proxy = ${!!wsAgent}, proxy = ${LOCAL_PROXY}`);

const app = express();

// 通用的 header 清洗（去掉 Origin/Referer，以免被 Binance WAF 拦截）
function stripHeaders(proxyReq) {
    try {
        proxyReq.removeHeader('origin');
        proxyReq.removeHeader('referer');
        proxyReq.setHeader(
            'user-agent',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36'
        );
        proxyReq.setHeader('accept', 'application/json');
    } catch (_) { }
}

// 便于排错：打印上游响应状态
function logUpstream(proxyRes, req) {
    console.log(`[REST] ${req.method} ${req.url} -> ${proxyRes.statusCode}`);
}

// ---------- REST 反代 → Binance REST ----------
const restProxy = createProxyMiddleware({
    target: 'https://api.binance.com',
    changeOrigin: true,
    secure: true,
    pathRewrite: { '^/api': '/api' }, // 形如 /api/v3/klines => /api/v3/klines
    agent: restAgent,
    logLevel: process.env.DEBUG_PROXY === '1' ? 'debug' : 'silent',
    onProxyReq: stripHeaders,
    onProxyRes: logUpstream,
    onError(err, req, res) {
        console.error('[REST] proxy error:', err?.message || err);
        res.status(502).end('Bad gateway');
    },
});
app.use('/api', restProxy);

// ---------- WS 反代 → Binance WebSocket ----------
const wsProxy = createProxyMiddleware({
    target: 'wss://stream.binance.com:9443',
    changeOrigin: true,
    ws: true,
    secure: true,
    pathRewrite: { '^/stream': '/stream' },
    agent: wsAgent,
    headers: { host: 'stream.binance.com' },
    timeout: 0,
    proxyTimeout: 0,
    logLevel: process.env.DEBUG_PROXY === '1' ? 'debug' : 'silent',
    onProxyReqWs(proxyReq, req, socket, options) {
        try {
            proxyReq.removeHeader('origin');
            proxyReq.removeHeader('referer');
            proxyReq.setHeader(
                'user-agent',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36'
            );
            proxyReq.setHeader('accept', '*/*');
            proxyReq.setHeader('cache-control', 'no-cache');
            proxyReq.setHeader('pragma', 'no-cache');
            proxyReq.setHeader('connection', 'Upgrade');
            proxyReq.setHeader('upgrade', 'websocket');
        } catch (_) { }
    },
    onError(err, req, res) {
        console.error('[WS] proxy error:', err?.message || err);
    },
});
app.use('/stream', wsProxy);

// 健康检查与静态资源（放在代理之后）
app.get('/healthz', (req, res) => res.end('ok'));
app.use(express.static(path.join(__dirname)));

// ---------- 启动 ----------
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
    console.log(`Server http://localhost:${PORT}`);
    console.log(`REST  -> http://localhost:${PORT}/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5`);
    console.log(`WS    -> ws://localhost:${PORT}/stream?streams=btcusdt@ticker`);
    console.log(`WS(2) -> ws://localhost:${PORT}/stream?streams=btcusdt@ticker/ethusdt@ticker`);
});

// 确保 WS 升级事件被代理处理（加日志便于排错）
server.on('upgrade', (req, socket, head) => {
    console.log(`[UPGRADE] ${req.url}`);
    wsProxy.upgrade(req, socket, head);
});