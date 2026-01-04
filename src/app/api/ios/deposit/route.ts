import { NextResponse } from "next/server";
import { z } from "zod";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "@/lib/crypto";
import { nowMs } from "@/lib/intmath";
import { withTx, ensureUser } from "@/lib/db";
import { pgBigint, pgJson } from "@/lib/pg";

export const runtime = "nodejs";

const DepositPayload = z.object({
  discordId: z.string().regex(/^\d+$/),
  amountKrw: z.coerce.number().int().positive(),
  depositorName: z.string().max(100).optional(),
  bankName: z.string().max(100).optional(),
  identifier: z.string().max(200).optional(),
  eventTsMs: z.coerce.number().int().positive(),
  nonce: z.string().min(8).max(200),
  signature: z.string().regex(/^[0-9a-fA-F]{64}$/), // hex hmac-sha256
});

export async function POST(req: Request) {
  const secret = process.env.IOS_DEPOSIT_SHARED_SECRET;
  if (!secret) {
    return NextResponse.json({ ok: false, error: "IOS_DEPOSIT_SHARED_SECRET not set" }, { status: 500 });
  }
  const maxSkewSec = Number(process.env.IOS_DEPOSIT_MAX_SKEW_SEC ?? "300");

  const raw = await req.text();
  const payloadHash = sha256Hex(raw);

  let parsed: z.infer<typeof DepositPayload>;
  try {
    parsed = DepositPayload.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  // Replay window check (server-side)
  const skewMs = Math.abs(nowMs() - parsed.eventTsMs);
  if (skewMs > maxSkewSec * 1000) {
    // Still log the event (as invalid), but do not credit.
  }

  const expectedSig = hmacSha256Hex(secret, payloadHash);
  const signatureValid = timingSafeEqualHex(parsed.signature.toLowerCase(), expectedSig);

  const discordId = BigInt(parsed.discordId);
  const amountKrw = BigInt(parsed.amountKrw);
  const shouldCredit = signatureValid && skewMs <= maxSkewSec * 1000;

  try {
    const result = await withTx(async (tx) => {
      await ensureUser(tx, discordId);

      // Insert event (dedupe by payload_hash + nonce)
      let inserted = false;
      try {
        await tx`
          INSERT INTO deposit_events (
            discord_id,
            amount_krw,
            depositor_name,
            bank_name,
            identifier,
            event_ts_ms,
            nonce,
            payload_hash,
            signature_valid,
            credited,
            raw_payload
          )
          VALUES (
            ${pgBigint(discordId)}::bigint,
            ${pgBigint(amountKrw)}::bigint,
            ${parsed.depositorName ?? null},
            ${parsed.bankName ?? null},
            ${parsed.identifier ?? null},
            ${String(parsed.eventTsMs)}::bigint,
            ${parsed.nonce},
            ${payloadHash},
            ${signatureValid},
            ${false},
            ${pgJson(parsed)}::jsonb
          )
        `;
        inserted = true;
      } catch (err: unknown) {
        // 23505 = unique_violation
        if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505") {
          return { ok: true, duplicated: true, credited: false, signatureValid };
        }
        throw err;
      }

      if (!inserted) {
        return { ok: true, duplicated: true, credited: false, signatureValid };
      }

      if (!shouldCredit) {
        return { ok: true, duplicated: false, credited: false, signatureValid };
      }

      await tx`
        UPDATE balances
        SET krw_balance = krw_balance + ${pgBigint(amountKrw)}::bigint, updated_at = now()
        WHERE discord_id = ${pgBigint(discordId)}::bigint
      `;

      await tx`
        INSERT INTO ledger_entries (discord_id, kind, delta_krw)
        VALUES (${pgBigint(discordId)}::bigint, 'deposit', ${pgBigint(amountKrw)}::bigint)
      `;

      await tx`
        UPDATE deposit_events
        SET credited = true
        WHERE payload_hash = ${payloadHash}
      `;

      return { ok: true, duplicated: false, credited: true, signatureValid };
    });

    return NextResponse.json(result, { status: 200 });
  } catch {
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

