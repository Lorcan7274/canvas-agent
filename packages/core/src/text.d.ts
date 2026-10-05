export declare function htmlToText(html: string | null | undefined): string;
export declare function truncate(s: string, max: number): string;
export interface Quantities {
    pages?: number;
    words?: number;
    problems?: number;
    questions?: number;
    minutes?: number;
    chapters?: number;
    sources?: number;
}
/**
 * Pulls "3 pages", "1500 words", "10 problems", "25 questions", "45 minutes",
 * "chapters 4-6", "5 sources" out of an assignment description. Ranges take
 * their upper bound ("2-3 pages" -> 3). Word numbers up to thirty are read.
 */
export declare function extractQuantities(text: string): Quantities;
export declare function sha256(s: string): string;
export declare function shortHash(s: string): string;
export declare function slugify(s: string): string;
