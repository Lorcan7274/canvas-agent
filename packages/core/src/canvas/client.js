/**
 * Canvas REST client. Works with a personal access token (server side) or a
 * logged-in session (extension side, `credentials: "include"`). Only GET.
 *
 * - Follows `Link: <...>; rel="next"` pagination.
 * - Strips the `while(1);` anti-hijack prefix Canvas adds to cookie-authed JSON.
 * - Backs off on 429 / "Rate Limit Exceeded", which Canvas meters per token.
 */
export class CanvasError extends Error {
    status;
    url;
    constructor(message, status, url) {
        super(message);
        this.status = status;
        this.url = url;
        this.name = "CanvasError";
    }
}
export function normaliseBaseUrl(input) {
    let s = input.trim();
    if (!/^https?:\/\//i.test(s))
        s = "https://" + s;
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
}
export function stripXssiPrefix(text) {
    return text.startsWith("while(1);") ? text.slice("while(1);".length) : text;
}
export function parseLinkNext(header) {
    if (!header)
        return undefined;
    for (const part of header.split(",")) {
        const m = part.match(/<([^>]+)>\s*;\s*rel="?next"?/);
        if (m)
            return m[1];
    }
    return undefined;
}
export class CanvasClient {
    baseUrl;
    token;
    fetchImpl;
    withCredentials;
    maxRetries;
    maxPages;
    sleep;
    constructor(opts) {
        this.baseUrl = normaliseBaseUrl(opts.baseUrl);
        this.token = opts.token;
        this.fetchImpl = opts.fetch ?? globalThis.fetch;
        this.withCredentials = opts.withCredentials ?? false;
        this.maxRetries = opts.maxRetries ?? 3;
        this.maxPages = opts.maxPages ?? 20;
        this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }
    url(path, query) {
        const u = new URL(path.startsWith("http") ? path : this.baseUrl + path);
        if (query) {
            for (const [k, v] of Object.entries(query)) {
                if (v === undefined)
                    continue;
                if (Array.isArray(v)) {
                    for (const x of v)
                        u.searchParams.append(k.endsWith("[]") ? k : `${k}[]`, String(x));
                }
                else {
                    u.searchParams.set(k, String(v));
                }
            }
        }
        return u.toString();
    }
    async request(url) {
        const headers = { Accept: "application/json" };
        if (this.token)
            headers["Authorization"] = `Bearer ${this.token}`;
        let attempt = 0;
        for (;;) {
            const init = { method: "GET", headers };
            if (this.withCredentials)
                init.credentials = "include";
            const res = await this.fetchImpl(url, init);
            const throttled = res.status === 429 || (res.status === 403 && /rate limit/i.test(res.headers.get("x-rate-limit-remaining") ? "rate limit" : await res.clone().text().catch(() => "")));
            if (throttled && attempt < this.maxRetries) {
                attempt++;
                await this.sleep(500 * 2 ** attempt);
                continue;
            }
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                throw new CanvasError(`Canvas ${res.status} for ${url}: ${body.slice(0, 200)}`, res.status, url);
            }
            return res;
        }
    }
    async get(path, query) {
        const res = await this.request(this.url(path, query));
        const text = await res.text();
        return JSON.parse(stripXssiPrefix(text));
    }
    async getAll(path, query) {
        const out = [];
        let next = this.url(path, { per_page: 100, ...query });
        let pages = 0;
        while (next && pages < this.maxPages) {
            const res = await this.request(next);
            const page = JSON.parse(stripXssiPrefix(await res.text()));
            if (Array.isArray(page))
                out.push(...page);
            else
                out.push(page);
            next = parseLinkNext(res.headers.get("link"));
            pages++;
        }
        return out;
    }
    self() {
        return this.get("/api/v1/users/self");
    }
    courses() {
        return this.getAll("/api/v1/courses", { enrollment_state: "active", "include[]": ["term"] });
    }
    plannerItems(startDate, endDate) {
        return this.getAll("/api/v1/planner/items", { start_date: startDate, end_date: endDate });
    }
    missingSubmissions() {
        return this.getAll("/api/v1/users/self/missing_submissions", {
            "filter[]": ["submittable"],
            "include[]": ["course", "planner_overrides"],
        });
    }
    assignment(courseId, assignmentId) {
        return this.get(`/api/v1/courses/${courseId}/assignments/${assignmentId}`, {
            "include[]": ["submission", "score_statistics"],
        });
    }
    quiz(courseId, quizId) {
        return this.get(`/api/v1/courses/${courseId}/quizzes/${quizId}`);
    }
    discussion(courseId, topicId) {
        return this.get(`/api/v1/courses/${courseId}/discussion_topics/${topicId}`);
    }
}
//# sourceMappingURL=client.js.map