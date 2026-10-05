/** Sealed secrets: AES-256-GCM under a key derived from SECRET_KEY. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";

export class Sealer {
  private readonly key: Buffer;

  constructor(masterSecret: string, purpose = "canvas-agent/secrets/v1") {
    if (!masterSecret || masterSecret.length < 16) {
      throw new Error("SECRET_KEY must be at least 16 characters");
    }
    this.key = Buffer.from(hkdfSync("sha256", masterSecret, "canvas-agent", purpose, 32));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return "v1:" + Buffer.concat([iv, tag, ct]).toString("base64");
  }

  open(sealed: string): string {
    if (!sealed.startsWith("v1:")) throw new Error("unknown sealed format");
    const buf = Buffer.from(sealed.slice(3), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
/** Characters in a pairing code: a 4-character lookup and an 8-character secret, 60 bits in all. */
export const PAIRING_CODE_LENGTH = 12;
export const PAIRING_LOOKUP_LENGTH = 4;

/** Twelve characters without look-alikes, shown as ABCD-EFGH-JKLM. 256 is a multiple of 32, so no modulo bias. */
export function pairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (const b of bytes) out += PAIRING_ALPHABET[b % PAIRING_ALPHABET.length];
  return out.match(/.{4}/g)!.join("-");
}

/** What the student typed, uppercased with spaces and dashes removed; undefined when it cannot be a code. */
export function normalisePairingCode(input: string): string | undefined {
  const s = input.toUpperCase().replace(/[\s-]+/g, "");
  if (s.length !== PAIRING_CODE_LENGTH) return undefined;
  for (const ch of s) if (!PAIRING_ALPHABET.includes(ch)) return undefined;
  return s;
}
