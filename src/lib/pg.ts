// Helpers for passing BigInt to @vercel/postgres (which accepts only primitives).
export function pgBigint(x: bigint): string {
  return x.toString();
}

export function pgJson(x: unknown): string {
  return JSON.stringify(x);
}

