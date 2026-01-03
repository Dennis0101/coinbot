import { sql } from "@vercel/postgres";
import type { QueryResultRow } from "@vercel/postgres";
import { pgBigint } from "@/lib/pg";

export async function withTx<T>(fn: (tx: typeof sql) => Promise<T>): Promise<T> {
  const client = await sql.connect();
  try {
    await client.query("BEGIN");
    const res = await fn(client as unknown as typeof sql);
    await client.query("COMMIT");
    return res;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function ensureUser(tx: typeof sql, discordId: bigint) {
  await tx`
    INSERT INTO users (discord_id)
    VALUES (${pgBigint(discordId)}::bigint)
    ON CONFLICT (discord_id) DO NOTHING
  `;
  await tx`
    INSERT INTO balances (discord_id, krw_balance)
    VALUES (${pgBigint(discordId)}::bigint, 0)
    ON CONFLICT (discord_id) DO NOTHING
  `;
  // Initialize per-coin balances lazily (on read/write)
}

export async function getKrwBalance(discordId: bigint): Promise<bigint> {
  const r = await sql<{ krw_balance: string }>`
    SELECT krw_balance::text AS krw_balance
    FROM balances
    WHERE discord_id = ${pgBigint(discordId)}::bigint
  `;
  if (!r.rows.length) return 0n;
  return BigInt(r.rows[0].krw_balance);
}

export async function getCoinBalances(discordId: bigint): Promise<Record<string, bigint>> {
  const r = await sql<{ symbol: string; balance_atomic: string }>`
    SELECT symbol, balance_atomic::text AS balance_atomic
    FROM user_coin_balances
    WHERE discord_id = ${pgBigint(discordId)}::bigint
  `;
  const out: Record<string, bigint> = {};
  for (const row of r.rows) out[row.symbol] = BigInt(row.balance_atomic);
  return out;
}

export async function queryOne<O extends QueryResultRow>(q: Promise<{ rows: O[] }>): Promise<O | null> {
  const r = await q;
  return r.rows[0] ?? null;
}

