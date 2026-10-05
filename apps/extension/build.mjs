import { build } from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("build", { recursive: true });
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/options.ts"],
  bundle: true,
  format: "esm",
  target: "chrome120",
  outdir: "build",
  sourcemap: false,
  minify: false,
});
copyFileSync("manifest.json", "build/manifest.json");
copyFileSync("options.html", "build/options.html");
console.log("extension built into apps/extension/build; load it unpacked from there");
