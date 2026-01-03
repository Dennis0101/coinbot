import nacl from "tweetnacl";

function hexToUint8Array(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function verifyDiscordRequest(opts: {
  publicKeyHex: string;
  signatureHex: string;
  timestamp: string;
  body: string;
}): boolean {
  try {
    const pk = hexToUint8Array(opts.publicKeyHex);
    const sig = hexToUint8Array(opts.signatureHex);
    const msg = new TextEncoder().encode(opts.timestamp + opts.body);
    return nacl.sign.detached.verify(msg, sig, pk);
  } catch {
    return false;
  }
}

