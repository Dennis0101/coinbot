import { sql } from "@vercel/postgres";
import { env } from "@/lib/env";
import { pgJson } from "@/lib/pg";

export async function recordAdminAlert(kind: string, message: string, context?: unknown) {
  const ctx = context === undefined ? null : pgJson(context);
  await sql`
    INSERT INTO admin_alerts (kind, message, context)
    VALUES (${kind}, ${message}, ${ctx}::jsonb)
  `;
}

export async function postDiscordAdminWebhook(content: string) {
  const e = env();
  if (!e.ADMIN_DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(e.ADMIN_DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch {
    // best-effort
  }
}

export async function alert(kind: string, message: string, context?: unknown) {
  await recordAdminAlert(kind, message, context);
  await postDiscordAdminWebhook(`[${kind}] ${message}`);
}

