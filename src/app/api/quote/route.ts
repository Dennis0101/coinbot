import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { parseCoinSymbol } from "@/lib/prices";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const symbolParam = url.searchParams.get("symbol");

  if (symbolParam) {
    let symbol: string;
    try {
      symbol = parseCoinSymbol(symbolParam);
    } catch {
      return NextResponse.json({ ok: false, error: "unsupported_symbol" }, { status: 400 });
    }

    const r = await sql<{
      symbol: string;
      foreign_usd_price_e6: string;
      fx_krw_per_usd_e4: string;
      domestic_krw_price: string;
      kimchi_bp: number;
      buy_krw_price: string;
      fee_bp: number;
      sources: unknown;
      updated_at: string;
    }>`
      SELECT
        symbol,
        foreign_usd_price_e6::text AS foreign_usd_price_e6,
        fx_krw_per_usd_e4::text AS fx_krw_per_usd_e4,
        domestic_krw_price::text AS domestic_krw_price,
        kimchi_bp,
        buy_krw_price::text AS buy_krw_price,
        fee_bp,
        sources,
        updated_at
      FROM price_cache
      WHERE symbol = ${symbol}
      LIMIT 1
    `;
    if (!r.rows.length) return NextResponse.json({ ok: false, error: "not_cached" }, { status: 404 });
    return NextResponse.json({ ok: true, data: r.rows[0] });
  }

  const r = await sql<{
    symbol: string;
    foreign_usd_price_e6: string;
    fx_krw_per_usd_e4: string;
    domestic_krw_price: string;
    kimchi_bp: number;
    buy_krw_price: string;
    fee_bp: number;
    sources: unknown;
    updated_at: string;
  }>`
    SELECT
      symbol,
      foreign_usd_price_e6::text AS foreign_usd_price_e6,
      fx_krw_per_usd_e4::text AS fx_krw_per_usd_e4,
      domestic_krw_price::text AS domestic_krw_price,
      kimchi_bp,
      buy_krw_price::text AS buy_krw_price,
      fee_bp,
      sources,
      updated_at
    FROM price_cache
    ORDER BY symbol ASC
  `;
  return NextResponse.json({ ok: true, data: r.rows });
}

