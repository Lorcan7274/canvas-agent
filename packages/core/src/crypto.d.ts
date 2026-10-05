export declare class Sealer {
    private readonly key;
    constructor(masterSecret: string, purpose?: string);
    seal(plaintext: string): string;
    open(sealed: string): string;
}
export declare function randomToken(bytes?: number): string;
export declare function hashToken(token: string): string;
export declare function safeEqual(a: string, b: string): boolean;
/** Six-character pairing codes without look-alike characters. */
export declare function pairingCode(): string;
