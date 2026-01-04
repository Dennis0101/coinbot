export const SUPPORTED_COINS = ["BTC", "ETH", "LTC", "XRP", "TRX"] as const;
export type CoinSymbol = (typeof SUPPORTED_COINS)[number];

// Atomic unit scale per 1 coin (integer-only accounting)
export const COIN_UNIT_SCALE: Record<CoinSymbol, bigint> = {
  BTC: 100_000_000n, // sats
  ETH: 1_000_000_000_000_000_000n, // wei
  LTC: 100_000_000n,
  XRP: 1_000_000n,
  TRX: 1_000_000n,
};

export function isSupportedCoin(x: string): x is CoinSymbol {
  return (SUPPORTED_COINS as readonly string[]).includes(x);
}

export function upbitMarket(symbol: CoinSymbol): string {
  return `KRW-${symbol}`;
}

export function binanceSymbol(symbol: CoinSymbol): string {
  // Binance uses USDT markets for these tickers.
  return `${symbol}USDT`;
}

