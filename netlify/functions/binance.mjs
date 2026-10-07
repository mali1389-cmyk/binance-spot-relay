const UPSTREAMS = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com",
];

const ROUTES = new Map([
  ["/api/v3/time", 1],
  ["/api/v3/exchangeInfo", 300],
  ["/api/v3/ticker/24hr", 5],
  ["/api/v3/klines", 5],
]);

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

function validQuery(pathname, searchParams) {
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
  if (symbol && !/^[A-Z0-9]{2,22}$/.test(symbol)) return false;
  const interval = searchParams.get("interval");
  if (interval && !/^(1s|1m|3m|5m|15m|30m|1h|2h|4h|6h|8h|12h|1d|3d|1w|1M)$/.test(interval)) return false;
  const limit = searchParams.get("limit");
  if (limit && (!/^\d{1,4}$/.test(limit) || Number(limit) > 1000)) return false;
  return true;
}

async function fetchBinance(pathAndQuery) {
  let lastError;
  for (const upstream of UPSTREAMS) {
    try {
      const response = await fetch(`${upstream}${pathAndQuery}`, {
        headers: { accept: "application/json", "user-agent": "binance-spot-relay/1.0" },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.arrayBuffer();
      if (response.ok || (response.status !== 451 && response.status < 500)) {
        return { response, body };
      }
      lastError = new Error(`Binance HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("All Binance upstreams failed");
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
      },
    });
  }
  if (request.method !== "GET") return json(405, { error: "Method not allowed" });

  const url = new URL(request.url);
  if (url.pathname === "/health") return json(200, { ok: true, service: "binance-spot-relay" });
  const ttl = ROUTES.get(url.pathname);
  if (ttl === undefined || !validQuery(url.pathname, url.searchParams)) {
    return json(400, { error: "Unsupported Binance Spot request" });
  }

  try {
    const { response, body } = await fetchBinance(`${url.pathname}${url.search}`);
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": `public, max-age=${ttl}`,
        "netlify-cdn-cache-control": `public, durable, max-age=${ttl}, stale-while-revalidate=30`,
        "access-control-allow-origin": "*",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error(error);
    return json(502, { error: "Binance Spot is temporarily unavailable" });
  }
};

export const config = {
  path: ["/health", "/api/v3/*"],
};
