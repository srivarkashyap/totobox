"use strict";
// extension/src/http-client.ts
/**
 * Small typed HTTP client for the Totobox extension.
 * - Uses node's built-in http/https (no node-fetch dependency)
 * - Exposes typed helpers: get<T>(), post<T>(), postJson<T>(), clearCache(), buildQuery()
 *
 * Notes:
 * - This file intentionally avoids global `fetch` or `node-fetch` to prevent
 *   the "Cannot find module 'node-fetch'" TypeScript error in environments
 *   where node-fetch is not installed or not desired.
 * - Requires @types/node present in your devDependencies (for Node types).
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpClient = exports.buildQuery = exports.postJson = exports.post = exports.get = exports.clearCache = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const DEFAULT_TIMEOUT = 15000;
const DEFAULT_CACHE_TTL = 60000; // 60s
// Very small cache for GET responses
const cache = new Map();
/**
 * Clear the in-memory cache (useful for retry flows).
 */
function clearCache() {
    cache.clear();
}
exports.clearCache = clearCache;
/**
 * Build http/https request options.
 */
function buildRequestOptions(urlStr, method, headers) {
    const url = new url_1.URL(urlStr);
    const isHttps = url.protocol === 'https:';
    const opts = {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: url.pathname + url.search,
        method,
        headers: headers || {},
    };
    return { opts, isHttps };
}
/**
 * Low-level request using Node's http/https modules.
 */
function lowLevelRequest(url, method, body, opts) {
    return new Promise((resolve) => {
        try {
            const { opts: reqOpts, isHttps } = buildRequestOptions(url, method, opts?.headers);
            const client = isHttps ? https : http;
            const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;
            const req = client.request(reqOpts, (res) => {
                const chunks = [];
                res.on('data', (chunk) => {
                    chunks.push(Buffer.from(chunk));
                });
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const status = res.statusCode || 0;
                    // Try to parse JSON if possible, otherwise return raw
                    let parsed = undefined;
                    try {
                        parsed = raw && raw.length > 0 ? JSON.parse(raw) : undefined;
                    }
                    catch {
                        parsed = raw;
                    }
                    if (status >= 200 && status < 300) {
                        resolve({
                            success: true,
                            status,
                            data: parsed,
                        });
                    }
                    else {
                        resolve({
                            success: false,
                            status,
                            error: typeof parsed === 'string' ? parsed : JSON.stringify(parsed),
                        });
                    }
                });
            });
            req.on('error', (err) => {
                resolve({
                    success: false,
                    status: 0,
                    error: err?.message || 'Request error',
                });
            });
            req.setTimeout(timeout, () => {
                // Timeout -> abort request and return an error
                try {
                    req.abort();
                }
                catch (_) { }
                resolve({
                    success: false,
                    status: 0,
                    error: `Request timed out after ${timeout}ms`,
                });
            });
            if (body !== undefined && body !== null) {
                const payload = typeof body === 'string' ? body : JSON.stringify(body);
                // Ensure content-type header exists; prefer provided header if present
                if (!opts?.headers || !Object.keys(opts.headers).some(h => h.toLowerCase() === 'content-type')) {
                    req.setHeader('Content-Type', 'application/json');
                }
                req.write(payload);
            }
            req.end();
        }
        catch (err) {
            resolve({
                success: false,
                status: 0,
                error: err?.message ?? 'Unknown request creation error',
            });
        }
    });
}
/**
 * GET helper with optional caching.
 */
async function get(url, opts) {
    try {
        const useCache = !!opts?.cache;
        const ttl = opts?.cacheTTL ?? DEFAULT_CACHE_TTL;
        const cacheKey = `GET:${url}:${JSON.stringify(opts?.headers || {})}`;
        if (useCache) {
            const cached = cache.get(cacheKey);
            if (cached && (Date.now() - cached.ts) < cached.ttl) {
                return {
                    success: true,
                    status: 200,
                    data: cached.value,
                    cached: true,
                };
            }
        }
        const res = await lowLevelRequest(url, 'GET', undefined, opts);
        if (res.success && useCache) {
            cache.set(cacheKey, { ts: Date.now(), value: res.data, ttl });
        }
        return res;
    }
    catch (err) {
        return {
            success: false,
            status: 0,
            error: err?.message ?? 'Unknown get() error',
        };
    }
}
exports.get = get;
/**
 * POST helper.
 */
async function post(url, body, opts) {
    try {
        const res = await lowLevelRequest(url, 'POST', body, opts);
        return res;
    }
    catch (err) {
        return {
            success: false,
            status: 0,
            error: err?.message ?? 'Unknown post() error',
        };
    }
}
exports.post = post;
/**
 * Convenience JSON POST.
 */
async function postJson(url, payload, opts) {
    const headers = Object.assign({}, opts?.headers || {}, { 'Content-Type': 'application/json' });
    return post(url, payload, Object.assign({}, opts || {}, { headers }));
}
exports.postJson = postJson;
/**
 * Build query string from object.
 */
function buildQuery(params) {
    if (!params)
        return '';
    const parts = [];
    Object.keys(params).forEach((k) => {
        const v = params[k];
        if (v === undefined || v === null)
            return;
        if (Array.isArray(v)) {
            v.forEach((item) => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`));
        }
        else {
            parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
        }
    });
    return parts.length ? `?${parts.join('&')}` : '';
}
exports.buildQuery = buildQuery;
/* Export a compact httpClient object */
exports.httpClient = {
    get,
    post,
    postJson,
    clearCache,
    buildQuery,
};
exports.default = exports.httpClient;
//# sourceMappingURL=http-client.js.map