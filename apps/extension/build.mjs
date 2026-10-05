import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeIcons } from "./icons.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "build");
// One build serves Chrome/Edge (service_worker) and Firefox (background.scripts as a module).
const target = ["chrome121", "firefox128"];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// The worker and the options page are modules.
await build({ entryPoints: [join(here, "src/background.ts"), join(here, "src/options.ts")], bundle: true, format: "esm", target, outdir: out, sourcemap: false, minify: false });
// A content script is a classic script: wrapped, so nothing lands in the page's isolated world's globals.
await build({ entryPoints: [join(here, "src/content.ts")], bundle: true, format: "iife", target, outdir: out, sourcemap: false, minify: false });
copyFileSync(join(here, "manifest.json"), join(out, "manifest.json"));
copyFileSync(join(here, "options.html"), join(out, "options.html"));
writeIcons(join(out, "icons"));
console.log("extension built into apps/extension/build; load it unpacked from there (Firefox: about:debugging, Load Temporary Add-on, build/manifest.json)");
