import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { COIN_UNIT_SCALE, SUPPORTED_COINS } from "@/lib/constants";
import { alert } from "@/lib/alerts";
import { pgBigint } from "@/lib/pg";

export const runtime = "nodejs";

export async function GET() {
  const startedAt = Date.now();

  // Ensure inventory rows exist for supported coins
  for (const s of SUPPORTED_COINS) {
    await sql`
      INSERT INTO coin_inventory (symbol, available_atomic, reserved_atomic, suspended)
      VALUES (${s}, 0, 0, false)
      ON CONFLICT (symbol) DO NOTHING
    `;
  }

  // Re-query after initialization
  const inv = await sql<{
    symbol: string;
    available_atomic: string;
    reserved_atomic: string;
    domestic_krw_price: string | null;
  }>`
    SELECT
      i.symbol,
      i.available_atomic::text AS available_atomic,
      i.reserved_atomic::text AS reserved_atomic,
      p.domestic_krw_price::text AS domestic_krw_price
    FROM coin_inventory i
    LEFT JOIN price_cache p ON p.symbol = i.symbol
    ORDER BY i.symbol ASC
  `;

  const out: Array<{
    symbol: string;
    available_atomic: string;
    reserved_atomic: string;
    sellable_atomic: string;
    price_krw: string;
    value_krw: string;
  }> = [];
  for (const row of inv.rows) {
    const symbol = row.symbol as keyof typeof COIN_UNIT_SCALE;
    const unitScale = COIN_UNIT_SCALE[symbol];
    const available = BigInt(row.available_atomic);
    const reserved = BigInt(row.reserved_atomic);
    const sellable = available - reserved;

    const priceKrw = row.domestic_krw_price ? BigInt(row.domestic_krw_price) : 0n;
    const valueKrw = priceKrw > 0n ? (available * priceKrw) / unitScale : 0n;

    await sql`
      INSERT INTO inventory_valuation (symbol, available_atomic, unit_scale, price_krw, value_krw, updated_at)
      VALUES (
        ${symbol},
        ${pgBigint(available)}::bigint,
        ${Number(unitScale)},
        ${pgBigint(priceKrw)}::bigint,
        ${pgBigint(valueKrw)}::bigint,
        now()
      )
      ON CONFLICT (symbol) DO UPDATE SET
        available_atomic = EXCLUDED.available_atomic,
        unit_scale = EXCLUDED.unit_scale,
        price_krw = EXCLUDED.price_krw,
        value_krw = EXCLUDED.value_krw,
        updated_at = now()
    `;

    if (sellable <= 0n) {
      await sql`UPDATE coin_inventory SET suspended = true, updated_at = now() WHERE symbol = ${symbol}`;
      await alert("inventory_low", `${symbol} 재고 부족으로 판매 중단(sellable<=0).`, {
        symbol,
        available: available.toString(),
        reserved: reserved.toString(),
      });
    }

    out.push({
      symbol,
      available_atomic: available.toString(),
      reserved_atomic: reserved.toString(),
      sellable_atomic: sellable.toString(),
      price_krw: priceKrw.toString(),
      value_krw: valueKrw.toString(),
    });
  }

  return NextResponse.json({ ok: true, ms: Date.now() - startedAt, data: out });
}

