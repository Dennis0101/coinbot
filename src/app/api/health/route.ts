import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const runtime = "nodejs";

export async function GET() {
  try {
    await sql`SELECT 1 as ok`;
    return NextResponse.json({ ok: true, db: true });
  } catch {
    return NextResponse.json({ ok: true, db: false });
  }
}

