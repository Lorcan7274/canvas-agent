/** Sealed secrets: AES-256-GCM under a key derived from SECRET_KEY. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
export class Sealer {
    key;
    constructor(masterSecret, purpose = "canvas-agent/secrets/v1") {
        if (!masterSecret || masterSecret.length < 16) {
            throw new Error("SECRET_KEY must be at least 16 characters");
        }
        this.key = Buffer.from(hkdfSync("sha256", masterSecret, "canvas-agent", purpose, 32));
    }
    seal(plaintext) {
        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const tag = cipher.getAuthTag();
        return "v1:" + Buffer.concat([iv, tag, ct]).toString("base64");
    }
    open(sealed) {
        if (!sealed.startsWith("v1:"))
            throw new Error("unknown sealed format");
        const buf = Buffer.from(sealed.slice(3), "base64");
        const iv = buf.subarray(0, 12);
        const tag = buf.subarray(12, 28);
        const ct = buf.subarray(28);
        const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    }
}
export function randomToken(bytes = 32) {
    return randomBytes(bytes).toString("base64url");
}
export function hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
}
export function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** Six-character pairing codes without look-alike characters. */
export function pairingCode() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = randomBytes(6);
    let out = "";
    for (const b of bytes)
        out += alphabet[b % alphabet.length];
    return out;
}
//# sourceMappingURL=crypto.js.map