// The scanners only use active USDT Spot markets. Avoid transferring Binance's
// large permission/filter metadata for markets that cannot appear in the UI.
export function upstreamRequestPath(url) {
  const upstream = new URL(url);
  if (upstream.pathname === "/api/v3/exchangeInfo" && !upstream.search) {
    upstream.searchParams.set("permissions", "SPOT");
    upstream.searchParams.set("symbolStatus", "TRADING");
    upstream.searchParams.set("showPermissionSets", "false");
  }
  return `${upstream.pathname}${upstream.search}`;
}

export function compactMarketData(url, body) {
  if (url.search || !["/api/v3/exchangeInfo", "/api/v3/ticker/24hr"].includes(url.pathname)) {
    return body;
  }
  const data = JSON.parse(new TextDecoder().decode(body));
  if (url.pathname === "/api/v3/exchangeInfo") {
    return JSON.stringify({
      timezone: data.timezone,
      serverTime: data.serverTime,
      symbols: data.symbols
        .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING" && s.isSpotTradingAllowed !== false)
        .map(({ symbol, baseAsset, quoteAsset, status, isSpotTradingAllowed }) => ({
          symbol, baseAsset, quoteAsset, status, isSpotTradingAllowed,
        })),
    });
  }
  return JSON.stringify(data
    .filter((ticker) => ticker.symbol.endsWith("USDT"))
    .map(({ symbol, lastPrice, priceChangePercent, quoteVolume }) => ({
      symbol, lastPrice, priceChangePercent, quoteVolume,
    })));
}
