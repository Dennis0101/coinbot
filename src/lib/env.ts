import { z } from "zod";

const nonEmpty = z.string().min(1);

export const Env = z.object({
  // Vercel Postgres (provided by integration)
  POSTGRES_URL: z.string().optional(),
  POSTGRES_PRISMA_URL: z.string().optional(),
  POSTGRES_URL_NON_POOLING: z.string().optional(),

  // Discord
  DISCORD_PUBLIC_KEY: nonEmpty.optional(), // required for /api/discord/interactions
  DISCORD_APPLICATION_ID: nonEmpty.optional(), // used by scripts/register-commands
  DISCORD_BOT_TOKEN: nonEmpty.optional(), // used by scripts/register-commands
  ADMIN_ROLE_IDS: z.string().optional(), // comma-separated role IDs
  ADMIN_DISCORD_WEBHOOK_URL: z.string().url().optional(), // optional alert sink

  // iOS deposit webhook security
  IOS_DEPOSIT_SHARED_SECRET: nonEmpty.optional(),
  IOS_DEPOSIT_MAX_SKEW_SEC: z.coerce.number().int().positive().default(300),

  // Payment provider webhook (optional placeholder)
  PAYMENT_WEBHOOK_SECRET: nonEmpty.optional(),

  // Public base URL used in Discord messages (e.g. https://your-app.vercel.app)
  APP_BASE_URL: z.string().url().optional(),

  // Pricing / fees
  FEE_BP: z.coerce.number().int().nonnegative().default(150), // 1.50%
  TRANSFER_FEE_BP: z.coerce.number().int().nonnegative().default(30), // 0.30%

  // Misc
  NODE_ENV: z.string().optional(),
  VERCEL: z.string().optional(),
});

export function env() {
  return Env.parse(process.env);
}

export function requireEnv(name: keyof z.infer<typeof Env>) {
  const e = env();
  const v = e[name];
  if (!v) throw new Error(`Missing env var: ${String(name)}`);
  return v as string;
}

export function adminRoleIdSet(): Set<string> {
  const e = env();
  const raw = e.ADMIN_ROLE_IDS?.trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

