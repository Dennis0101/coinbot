import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { SUPPORTED_COINS } from "@/lib/constants";
import { buildPriceSnapshot } from "@/lib/prices";
import { alert } from "@/lib/alerts";
import { pgBigint, pgJson } from "@/lib/pg";

export const runtime = "nodejs";

function isCronInvocation(req: Request): boolean {
  // Best-effort: Vercel cron requests include x-vercel-cron.
  const h = req.headers.get("x-vercel-cron");
  if (h === "1" || h === "true") return true;
  return false;
}

export async function GET(req: Request) {
  const startedAt = Date.now();

  // Throttle if called too frequently (prevents abuse / provider rate limits)
  const last = await sql<{ updated_at: string }>`
    SELECT updated_at::text AS updated_at
    FROM price_cache
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  if (last.rows[0]) {
    const updatedAt = new Date(last.rows[0].updated_at).getTime();
    if (Date.now() - updatedAt < 30_000 && !isCronInvocation(req)) {
      return NextResponse.json({ ok: true, skipped: true, reason: "throttled" });
    }
  }

  const results: Array<{ symbol: string; ok: boolean; error?: string }> = [];
  for (const symbol of SUPPORTED_COINS) {
    try {
      const snap = await buildPriceSnapshot(symbol);
      await sql`
        INSERT INTO price_cache (
          symbol,
          foreign_usd_price_e6,
          fx_krw_per_usd_e4,
          domestic_krw_price,
          kimchi_bp,
          buy_krw_price,
          fee_bp,
          sources,
          updated_at
        )
        VALUES (
          ${snap.symbol},
          ${pgBigint(snap.foreign_usd_price_e6)}::bigint,
          ${pgBigint(snap.fx_krw_per_usd_e4)}::bigint,
          ${pgBigint(snap.domestic_krw_price)}::bigint,
          ${snap.kimchi_bp},
          ${pgBigint(snap.buy_krw_price)}::bigint,
          ${snap.fee_bp},
          ${pgJson(snap.sources)}::jsonb,
          now()
        )
        ON CONFLICT (symbol) DO UPDATE SET
          foreign_usd_price_e6 = EXCLUDED.foreign_usd_price_e6,
          fx_krw_per_usd_e4 = EXCLUDED.fx_krw_per_usd_e4,
          domestic_krw_price = EXCLUDED.domestic_krw_price,
          kimchi_bp = EXCLUDED.kimchi_bp,
          buy_krw_price = EXCLUDED.buy_krw_price,
          fee_bp = EXCLUDED.fee_bp,
          sources = EXCLUDED.sources,
          updated_at = now()
      `;
      results.push({ symbol, ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ symbol, ok: false, error: msg });
      await alert("price_refresh_failed", `${symbol}: ${msg}`, { symbol, error: msg });
    }
  }

  return NextResponse.json({
    ok: true,
    ms: Date.now() - startedAt,
    results,
  });
}

