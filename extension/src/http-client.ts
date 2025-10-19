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

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

export interface RequestOptions {
  headers?: Record<string, string>;
  /** enable simple in-memory cache for GET requests */
  cache?: boolean;
  /** cache ttl in ms (defaults to 60s) */
  cacheTTL?: number;
  /** request timeout in ms (defaults to 15s) */
  timeout?: number;
}

export interface HttpResponse<T = any> {
  success: boolean;
  status: number;
  data?: T;
  error?: string;
  cached?: boolean;
  fallback?: boolean;
}

/** Simple in-memory cache entry */
type CacheEntry = {
  ts: number;
  value: any;
  ttl: number;
};

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_CACHE_TTL = 60_000; // 60s

// Very small cache for GET responses
const cache = new Map<string, CacheEntry>();

/**
 * Clear the in-memory cache (useful for retry flows).
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Build http/https request options.
 */
function buildRequestOptions(urlStr: string, method: string, headers?: Record<string, string>) {
  const url = new URL(urlStr);
  const isHttps = url.protocol === 'https:';
  const opts: http.RequestOptions = {
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
function lowLevelRequest(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: any, opts?: RequestOptions): Promise<HttpResponse<any>> {
  return new Promise((resolve) => {
    try {
      const { opts: reqOpts, isHttps } = buildRequestOptions(url, method, opts?.headers);
      const client = isHttps ? https : http;
      const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

      const req = client.request(reqOpts, (res) => {
        const chunks: Buffer[] = [];

        res.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });

        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode || 0;

          // Try to parse JSON if possible, otherwise return raw
          let parsed: any = undefined;
          try {
            parsed = raw && raw.length > 0 ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }

          if (status >= 200 && status < 300) {
            resolve({
              success: true,
              status,
              data: parsed,
            });
          } else {
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
        try { req.abort(); } catch (_) {}
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
    } catch (err: any) {
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
export async function get<T = any>(url: string, opts?: RequestOptions): Promise<HttpResponse<T>> {
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
          data: cached.value as T,
          cached: true,
        };
      }
    }

    const res = await lowLevelRequest(url, 'GET', undefined, opts);

    if (res.success && useCache) {
      cache.set(cacheKey, { ts: Date.now(), value: res.data, ttl });
    }

    return res;
  } catch (err: any) {
    return {
      success: false,
      status: 0,
      error: err?.message ?? 'Unknown get() error',
    };
  }
}

/**
 * POST helper.
 */
export async function post<T = any>(url: string, body?: any, opts?: RequestOptions): Promise<HttpResponse<T>> {
  try {
    const res = await lowLevelRequest(url, 'POST', body, opts);
    return res;
  } catch (err: any) {
    return {
      success: false,
      status: 0,
      error: err?.message ?? 'Unknown post() error',
    };
  }
}

/**
 * Convenience JSON POST.
 */
export async function postJson<T = any>(url: string, payload: any, opts?: RequestOptions): Promise<HttpResponse<T>> {
  const headers = Object.assign({}, opts?.headers || {}, { 'Content-Type': 'application/json' });
  return post<T>(url, payload, Object.assign({}, opts || {}, { headers }));
}

/**
 * Build query string from object.
 */
export function buildQuery(params?: Record<string, any>): string {
  if (!params) return '';
  const parts: string[] = [];
  Object.keys(params).forEach((k) => {
    const v = params[k];
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item) => parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`));
    } else {
      parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  });
  return parts.length ? `?${parts.join('&')}` : '';
}

/* Export a compact httpClient object */
export const httpClient = {
  get,
  post,
  postJson,
  clearCache,
  buildQuery,
};

export default httpClient;
