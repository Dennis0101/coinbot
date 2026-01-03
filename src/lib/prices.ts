import { env } from "@/lib/env";
import { binanceSymbol, isSupportedCoin, upbitMarket, type CoinSymbol, COIN_UNIT_SCALE } from "@/lib/constants";
import { parseDecimalToInt } from "@/lib/intmath";

export type PriceSnapshot = {
  symbol: CoinSymbol;
  foreign_usd_price_e6: bigint; // USD * 1e6
  fx_krw_per_usd_e4: bigint; // KRW per USD * 1e4
  foreign_krw_price: bigint; // derived KRW (won) per 1 coin
  domestic_krw_price: bigint; // KRW per 1 coin
  kimchi_bp: number; // basis points
  fee_bp: number;
  buy_krw_price: bigint; // KRW per 1 coin (final)
  sources: Record<string, unknown>;
};

function assertOkNumber(n: unknown, name: string): number {
  if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`Invalid ${name}`);
  return n;
}

async function fetchJson(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "user-agent": "vercel-coinbot/1.0", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return (await res.json()) as unknown;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export async function fetchFxKrwPerUsdE4(): Promise<{ fx_e4: bigint; source: unknown }> {
  const providers = [
    "https://open.er-api.com/v6/latest/USD",
    "https://api.exchangerate-api.com/v4/latest/USD",
  ];

  let lastErr: unknown = null;
  for (const url of providers) {
    try {
      const j = await fetchJson(url);
      const rates = isRecord(j) && isRecord(j.rates) ? j.rates : undefined;
      const krw = rates?.KRW ?? rates?.krw;
      const fx = assertOkNumber(krw, "fx KRW");
      // Convert to E4
      const fx_e4 = BigInt(Math.round(fx * 10_000));
      if (fx_e4 <= 0) throw new Error("FX <= 0");
      return { fx_e4, source: { provider: url, raw: j } };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("FX providers failed");
}

export async function fetchForeignUsdE6(symbol: CoinSymbol): Promise<{ usd_e6: bigint; source: unknown }> {
  // Binance spot ticker (USDT ~ USD)
  const pair = binanceSymbol(symbol);
  const url = `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`;
  const j = await fetchJson(url);
  const price = String(isRecord(j) ? j.price ?? "" : "");
  const usd_e6 = parseDecimalToInt(price, 1_000_000n);
  if (usd_e6 <= 0) throw new Error("USD price <= 0");
  return { usd_e6, source: { provider: "binance", pair, raw: j } };
}

export async function fetchDomesticKrw(symbol: CoinSymbol): Promise<{ krw: bigint; source: unknown }> {
  const market = upbitMarket(symbol);
  const url = `https://api.upbit.com/v1/ticker?markets=${encodeURIComponent(market)}`;
  const j = await fetchJson(url);
  const row = Array.isArray(j) && isRecord(j[0]) ? j[0] : null;
  const price = row ? row.trade_price : undefined;
  const krw = BigInt(Math.round(assertOkNumber(price, "domestic KRW")));
  if (krw <= 0n) throw new Error("Domestic KRW <= 0");
  return { krw, source: { provider: "upbit", market, raw: row } };
}

export function computeKimchiBp(foreignKrw: bigint, domesticKrw: bigint): number {
  if (foreignKrw <= 0n) return 0;
  const diff = domesticKrw - foreignKrw;
  const bp = (diff * 10_000n) / foreignKrw;
  // Clamp to avoid insane values on provider glitches
  const n = Number(bp);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-9_999, Math.min(9_999, Math.trunc(n)));
}

export function foreignKrwFrom(usd_e6: bigint, fx_e4: bigint): bigint {
  // (USD*1e6) * (KRW/USD*1e4) / 1e10 -> KRW
  return (usd_e6 * fx_e4) / 10_000_000_000n;
}

export async function buildPriceSnapshot(symbol: CoinSymbol): Promise<PriceSnapshot> {
  const e = env();
  const fee_bp = e.FEE_BP;

  const [fx, foreign, domestic] = await Promise.all([
    fetchFxKrwPerUsdE4(),
    fetchForeignUsdE6(symbol),
    fetchDomesticKrw(symbol),
  ]);

  const foreign_krw_price = foreignKrwFrom(foreign.usd_e6, fx.fx_e4);
  const kimchi_bp = computeKimchiBp(foreign_krw_price, domestic.krw);

  // buy_krw_price = foreign_krw * (1 + kimchi + fee)
  // kimchi_bp is relative to foreign. fee_bp is operator fee.
  const buy_krw_price = (foreign_krw_price * BigInt(10_000 + kimchi_bp + fee_bp)) / 10_000n;

  return {
    symbol,
    foreign_usd_price_e6: foreign.usd_e6,
    fx_krw_per_usd_e4: fx.fx_e4,
    foreign_krw_price,
    domestic_krw_price: domestic.krw,
    kimchi_bp,
    fee_bp,
    buy_krw_price,
    sources: {
      fx: fx.source,
      foreign: foreign.source,
      domestic: domestic.source,
      unit_scale: COIN_UNIT_SCALE[symbol].toString(),
    },
  };
}

export function parseCoinSymbol(x: string): CoinSymbol {
  const up = x.trim().toUpperCase();
  if (!isSupportedCoin(up)) throw new Error(`Unsupported coin: ${x}`);
  return up;
}

