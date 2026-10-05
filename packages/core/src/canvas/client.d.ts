/**
 * Canvas REST client. Works with a personal access token (server side) or a
 * logged-in session (extension side, `credentials: "include"`). Only GET.
 *
 * - Follows `Link: <...>; rel="next"` pagination.
 * - Strips the `while(1);` anti-hijack prefix Canvas adds to cookie-authed JSON.
 * - Backs off on 429 / "Rate Limit Exceeded", which Canvas meters per token.
 */
export declare class CanvasError extends Error {
    readonly status: number;
    readonly url: string;
    constructor(message: string, status: number, url: string);
}
export interface CanvasClientOptions {
    baseUrl: string;
    token?: string;
    fetch?: typeof fetch;
    /** Send cookies (extension content script / service worker). */
    withCredentials?: boolean;
    maxRetries?: number;
    /** Max pages followed per list call. 100 items per page. */
    maxPages?: number;
    sleep?: (ms: number) => Promise<void>;
}
export type Query = Record<string, string | number | boolean | Array<string | number> | undefined>;
export declare function normaliseBaseUrl(input: string): string;
export declare function stripXssiPrefix(text: string): string;
export declare function parseLinkNext(header: string | null): string | undefined;
export declare class CanvasClient {
    readonly baseUrl: string;
    private readonly token;
    private readonly fetchImpl;
    private readonly withCredentials;
    private readonly maxRetries;
    private readonly maxPages;
    private readonly sleep;
    constructor(opts: CanvasClientOptions);
    url(path: string, query?: Query): string;
    private request;
    get<T>(path: string, query?: Query): Promise<T>;
    getAll<T>(path: string, query?: Query): Promise<T[]>;
    self(): Promise<{
        id: number;
        name: string;
        primary_email?: string;
        login_id?: string;
    }>;
    courses(): Promise<unknown[]>;
    plannerItems(startDate: string, endDate: string): Promise<unknown[]>;
    missingSubmissions(): Promise<unknown[]>;
    assignment(courseId: string, assignmentId: string): Promise<unknown>;
    quiz(courseId: string, quizId: string): Promise<unknown>;
    discussion(courseId: string, topicId: string): Promise<unknown>;
}
