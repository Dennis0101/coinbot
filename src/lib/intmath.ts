// Utilities for integer-only finance math.

export function clampBigInt(x: bigint, min: bigint, max: bigint) {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

/**
 * Parse a decimal string into an integer scaled by `scale` (10^decimals).
 * Example: parseDecimalToInt("123.456", 1_000_000n) => 123456000n
 */
export function parseDecimalToInt(input: string, scale: bigint): bigint {
  const s = input.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid decimal: ${input}`);
  const [whole, frac = ""] = s.split(".");

  const scaleDigits = scale.toString().length - 1; // scale must be power of 10
  if (10n ** BigInt(scaleDigits) !== scale) {
    throw new Error(`Scale must be power of 10. Got: ${scale.toString()}`);
  }

  const fracPadded = (frac + "0".repeat(scaleDigits)).slice(0, scaleDigits);
  return BigInt(whole) * scale + BigInt(fracPadded || "0");
}

export function formatAtomicToDecimal(atomic: bigint, scale: bigint, maxFracDigits = 8): string {
  const scaleDigits = scale.toString().length - 1;
  const sign = atomic < 0 ? "-" : "";
  const a = atomic < 0 ? -atomic : atomic;
  const whole = a / scale;
  const frac = (a % scale).toString().padStart(scaleDigits, "0");
  const trimmed = frac.slice(0, Math.min(scaleDigits, maxFracDigits)).replace(/0+$/, "");
  return trimmed.length ? `${sign}${whole.toString()}.${trimmed}` : `${sign}${whole.toString()}`;
}

export function nowMs(): number {
  return Date.now();
}

