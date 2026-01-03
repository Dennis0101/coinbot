import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "@/lib/crypto";
import { withTx, ensureUser } from "@/lib/db";
import { pgBigint, pgJson } from "@/lib/pg";

export const runtime = "nodejs";

const PaymentPayload = z.object({
  provider: z.string().max(50).optional(),
  providerEventId: z.string().max(200).optional(),
  discordId: z.string().regex(/^\d+$/),
  amountKrw: z.coerce.number().int().positive(),
});

/**
 * Generic payment webhook endpoint.
 *
 * Expected:
 * - Header: x-payment-signature = hex(HMAC-SHA256(PAYMENT_WEBHOOK_SECRET, sha256(rawBody)))
 * - Body: { discordId, amountKrw, provider?, providerEventId? }
 *
 * Replace this with your real provider signature verification when integrating.
 */
export async function POST(req: Request) {
  const e = env();
  if (!e.PAYMENT_WEBHOOK_SECRET) {
    return NextResponse.json({ ok: false, error: "PAYMENT_WEBHOOK_SECRET not set" }, { status: 500 });
  }

  const sig = req.headers.get("x-payment-signature") ?? "";
  const raw = await req.text();
  const hash = sha256Hex(raw);
  const expected = hmacSha256Hex(e.PAYMENT_WEBHOOK_SECRET, hash);
  const signatureValid = timingSafeEqualHex(sig.toLowerCase(), expected);

  let parsed: z.infer<typeof PaymentPayload>;
  try {
    parsed = PaymentPayload.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  const discordId = BigInt(parsed.discordId);
  const amountKrw = BigInt(parsed.amountKrw);
  const provider = parsed.provider ?? "generic";
  const providerEventId = parsed.providerEventId ?? null;

  try {
    const res = await withTx(async (tx) => {
      await ensureUser(tx, discordId);

      try {
        await tx`
          INSERT INTO payment_events (
            provider, provider_event_id, discord_id, amount_krw, payload_hash, signature_valid, credited, raw_payload
          )
          VALUES (
            ${provider},
            ${providerEventId},
            ${pgBigint(discordId)}::bigint,
            ${pgBigint(amountKrw)}::bigint,
            ${hash},
            ${signatureValid},
            ${false},
            ${pgJson(parsed)}::jsonb
          )
        `;
      } catch (err: unknown) {
        if (typeof err === "object" && err !== null && "code" in err && (err as { code?: string }).code === "23505") {
          return { ok: true, duplicated: true, credited: false, signatureValid };
        }
        throw err;
      }

      if (!signatureValid) {
        return { ok: true, duplicated: false, credited: false, signatureValid };
      }

      await tx`
        UPDATE balances
        SET krw_balance = krw_balance + ${pgBigint(amountKrw)}::bigint, updated_at = now()
        WHERE discord_id = ${pgBigint(discordId)}::bigint
      `;
      await tx`
        INSERT INTO ledger_entries (discord_id, kind, delta_krw)
        VALUES (${pgBigint(discordId)}::bigint, 'payment_webhook', ${pgBigint(amountKrw)}::bigint)
      `;
      await tx`UPDATE payment_events SET credited = true WHERE payload_hash = ${hash}`;

      return { ok: true, duplicated: false, credited: true, signatureValid };
    });

    return NextResponse.json(res);
  } catch {
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}

