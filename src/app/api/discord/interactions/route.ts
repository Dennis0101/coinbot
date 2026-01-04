import { NextResponse } from "next/server";
import type { APIInteraction } from "discord-api-types/v10";
import { verifyDiscordRequest } from "@/lib/discord/verify";
import { handleDiscordInteraction } from "@/lib/discord/handlers";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    return NextResponse.json({ ok: false, error: "DISCORD_PUBLIC_KEY not set" }, { status: 500 });
  }

  const signature = req.headers.get("x-signature-ed25519");
  const timestamp = req.headers.get("x-signature-timestamp");
  if (!signature || !timestamp) {
    return NextResponse.json({ ok: false, error: "missing_signature_headers" }, { status: 401 });
  }

  const body = await req.text();
  const ok = verifyDiscordRequest({
    publicKeyHex: publicKey,
    signatureHex: signature,
    timestamp,
    body,
  });

  if (!ok) {
    return NextResponse.json({ ok: false, error: "invalid_signature" }, { status: 401 });
  }

  const interaction = JSON.parse(body) as APIInteraction;
  const response = await handleDiscordInteraction(interaction);
  return NextResponse.json(response);
}

