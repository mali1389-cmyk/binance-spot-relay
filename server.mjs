import http from "node:http";
import { compactMarketData, upstreamRequestPath } from "./market-data.mjs";

const PORT = Number(process.env.PORT || 10000);
const UPSTREAMS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
];

const ROUTES = new Map([
  ["/api/v3/time", { ttl: 1_000 }],
  ["/api/v3/exchangeInfo", { ttl: 5 * 60_000 }],
  ["/api/v3/ticker/24hr", { ttl: 5_000 }],
  ["/api/v3/klines", { ttl: 5_000 }],
]);

const cache = new Map();

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function isValidQuery(pathname, searchParams) {
  const allowed = pathname === "/api/v3/klines"
    ? new Set(["symbol", "interval", "limit", "startTime", "endTime", "timeZone"])
    : pathname === "/api/v3/ticker/24hr"
      ? new Set(["symbol", "symbols", "type"])
      : pathname === "/api/v3/exchangeInfo"
        ? new Set(["symbol", "symbols", "permissions", "showPermissionSets", "symbolStatus"])
        : new Set();

  for (const key of searchParams.keys()) {
    if (!allowed.has(key)) return false;
  }

  const symbol = searchParams.get("symbol");
  if (symbol && !/^[\p{L}\p{N}]{2,32}$/u.test(symbol)) return false;

  const interval = searchParams.get("interval");
  if (interval && !/^(1s|1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/.test(interval)) {
    return false;
  }

  const limit = searchParams.get("limit");
  if (limit && (!/^\d{1,4}$/.test(limit) || Number(limit) > 1000)) return false;

  return true;
}

async function fetchBinance(pathAndQuery) {
  let lastError;

  for (const upstream of UPSTREAMS) {
    try {
      const response = await fetch(`${upstream}${pathAndQuery}`, {
        headers: {
          accept: "application/json",
          "user-agent": "binance-spot-relay/1.0",
        },
        signal: AbortSignal.timeout(10_000),
      });

      const body = Buffer.from(await response.arrayBuffer());
      if (response.ok) {
        return {
          status: response.status,
          body,
          contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
        };
      }

      lastError = new Error(`Binance HTTP ${response.status}`);
      if (response.status !== 451 && response.status < 500) {
        return {
          status: response.status,
          body,
          contentType: response.headers.get("content-type") || "application/json; charset=utf-8",
        };
      }
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All Binance upstreams failed");
}

const server = http.createServer(async (request, response) => {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, OPTIONS");
  response.setHeader("x-content-type-options", "nosniff");

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { error: "Method not allowed" }, { allow: "GET, OPTIONS" });
    return;
  }

  const url = new URL(request.url || "/", "http://relay.local");
  if (url.pathname === "/" || url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "binance-spot-relay" });
    return;
  }

  const route = ROUTES.get(url.pathname);
  if (!route || !isValidQuery(url.pathname, url.searchParams)) {
    sendJson(response, 400, { error: "Unsupported Binance Spot request" });
    return;
  }

  const cacheKey = `${url.pathname}${url.search}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    response.writeHead(cached.status, {
      "content-type": cached.contentType,
      "cache-control": "public, max-age=1",
      "x-relay-cache": "HIT",
    });
    response.end(cached.body);
    return;
  }

  try {
    const result = await fetchBinance(upstreamRequestPath(url));
    if (result.status >= 200 && result.status < 300) {
      result.body = compactMarketData(url, result.body);
    }
    if (result.status >= 200 && result.status < 300) {
      cache.set(cacheKey, { ...result, expiresAt: Date.now() + route.ttl });
    }
    response.writeHead(result.status, {
      "content-type": result.contentType,
      "cache-control": "public, max-age=1",
      "x-relay-cache": "MISS",
    });
    response.end(result.body);
  } catch (error) {
    console.error(error);
    sendJson(response, 502, { error: "Binance Spot is temporarily unavailable" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Binance Spot relay listening on ${PORT}`);
});
