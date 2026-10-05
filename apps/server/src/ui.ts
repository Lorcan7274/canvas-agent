/** Tiny server-rendered HTML helpers. No framework, no client JS beyond a few lines. */

export function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
:root{--bg:#fbfaf7;--fg:#1f1d1a;--muted:#6b6660;--line:#e4e0d8;--accent:#1d4ed8;--ok:#15803d;--warn:#b45309;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#14130f;--fg:#ece8df;--muted:#a39d92;--line:#2c2a24;--accent:#8ab4ff;--ok:#5fd38a;--warn:#f0b35b;--card:#1c1a15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:52rem;margin:0 auto;padding:1.5rem 1rem 4rem}h1{font-size:1.5rem;margin:0 0 .25rem}h2{font-size:1.1rem;margin:2rem 0 .5rem}
p{margin:.25rem 0 .75rem}.muted{color:var(--muted)}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1rem;margin:.75rem 0}
form{margin:.5rem 0}label{display:block;font-size:.9rem;color:var(--muted);margin-top:.5rem}input,select,textarea{width:100%;padding:.5rem .6rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:.5rem .9rem;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--fg);font:inherit;cursor:pointer;margin-top:.5rem}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}button.danger{color:var(--warn)}
code,pre{font:.9rem ui-monospace,SFMono-Regular,Menlo,monospace}pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:.75rem;overflow:auto;white-space:pre-wrap;word-break:break-all}
table{width:100%;border-collapse:collapse;font-size:.95rem}td,th{text-align:left;padding:.4rem .3rem;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted);font-weight:500}
.row{display:flex;gap:.5rem;flex-wrap:wrap;align-items:end}.row>*{flex:1 1 12rem}.inline{display:inline;margin:0}.ok{color:var(--ok)}.warn{color:var(--warn)}
.flash{border-left:4px solid var(--accent);padding:.5rem .75rem;background:var(--card);margin:.75rem 0}
nav a{margin-right:1rem}a{color:var(--accent)}
`;

export function page(title: string, body: string, opts: { nav?: boolean } = {}): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><main>${opts.nav === false ? "" : `<nav><a href="/">Settings</a><a href="/logout">Sign out</a></nav>`}${body}</main></body></html>`;
}
