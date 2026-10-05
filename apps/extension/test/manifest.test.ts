/** The manifest's store limits and browser keys, the icons it names, and the Canvas host rule it shares with the worker. */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";
// @ts-expect-error a plain .mjs build helper, no types
import { ICON_SIZES, writeIcons } from "../icons.mjs";
import { canvasOriginRefusal, isInstructureCanvas } from "../src/shared.js";
import { manifest } from "./fake-chrome.js";

describe("the manifest", () => {
  it("fits the Chrome Web Store's limits and names icons the build writes", () => {
    expect(manifest.description!.length).toBeLessThanOrEqual(132);
    expect(Object.keys(manifest.icons ?? {}).map(Number)).toEqual(ICON_SIZES);
    expect(manifest.icons?.["128"]).toBe("icons/icon-128.png");
    expect(Object.values(manifest.action?.default_icon ?? {}).every((p) => Object.values(manifest.icons ?? {}).includes(p))).toBe(true);
  });

  it("runs from one build on Chrome (service worker) and Firefox (module background script, gecko id)", () => {
    const bg = manifest.background as { service_worker: string; scripts: string[]; type: string };
    expect(bg).toEqual({ service_worker: "background.js", scripts: ["background.js"], type: "module" });
    // Chrome accepts `scripts` beside `service_worker` from 121.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(121);
    const gecko = (manifest as unknown as { browser_specific_settings: { gecko: { id: string; strict_min_version: string } } }).browser_specific_settings.gecko;
    expect(gecko.id).toMatch(/^[\w.-]+@[\w.-]+$/);
    expect(Number.parseFloat(gecko.strict_min_version)).toBeGreaterThanOrEqual(128);
    expect((manifest as unknown as { options_ui: { page: string } }).options_ui.page).toBe("options.html");
  });

  it("keeps the content script off the hosts the worker refuses, and on a school's Canvas", () => {
    const [script] = manifest.content_scripts!;
    expect(script!.matches).toEqual(["https://*.instructure.com/*"]);
    const sample = (pattern: string) => pattern.replace("/*", "").replace("*.", "school.");
    for (const pattern of script!.exclude_matches!) expect(canvasOriginRefusal(sample(pattern)), pattern).toBeTruthy();
    expect(canvasOriginRefusal(sample(script!.matches![0]!))).toBeUndefined();
    expect(manifest.host_permissions).toEqual(script!.matches);
  });
});

describe("canvasOriginRefusal", () => {
  it.each([
    ["https://school.instructure.com", undefined],
    ["https://canvas.instructure.com", undefined],
    ["https://canvas.school.edu", undefined],
    ["https://canvas.school.edu:8443", undefined],
    ["https://school.beta.instructure.com", /beta or test copy/],
    ["https://school.test.instructure.com", /beta or test copy/],
    ["https://school.quiz-lti-iad-prod.instructure.com", /beta or test copy|Instructure service/],
    ["https://community.instructure.com", /Instructure's site/],
    ["https://www.instructure.com", /Instructure's site/],
    ["https://instructure.com", /Instructure's site/],
    ["http://school.instructure.com", /https/],
    ["http://canvas.school.edu", /https/],
    ["not a url", /not a web address/],
  ])("%s", (origin, expected) => {
    const got = canvasOriginRefusal(origin);
    if (expected === undefined) expect(got).toBeUndefined();
    else expect(got).toMatch(expected);
  });

  it("treats only a school's *.instructure.com Canvas as covered by the manifest", () => {
    expect(isInstructureCanvas("https://school.instructure.com")).toBe(true);
    expect(isInstructureCanvas("https://school.beta.instructure.com")).toBe(false);
    expect(isInstructureCanvas("https://canvas.school.edu")).toBe(false);
  });
});

describe("the icons", () => {
  it("are valid RGBA PNGs of every declared size", () => {
    const dir = mkdtempSync(join(tmpdir(), "planner-icons-"));
    try {
      const files = writeIcons(dir) as string[];
      expect(files.length).toBe(ICON_SIZES.length);
      for (const size of ICON_SIZES as number[]) {
        const file = join(dir, `icon-${size}.png`);
        expect(existsSync(file)).toBe(true);
        const png = readFileSync(file);
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const chunks: Array<{ type: string; data: Buffer }> = [];
        for (let at = 8; at < png.length; ) {
          const len = png.readUInt32BE(at);
          const type = png.toString("ascii", at + 4, at + 8);
          const data = png.subarray(at + 8, at + 8 + len);
          expect(png.readUInt32BE(at + 8 + len)).toBe(crc32(png.subarray(at + 4, at + 8 + len)));
          chunks.push({ type, data });
          at += 12 + len;
        }
        expect(chunks.map((c) => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
        const ihdr = chunks[0]!.data;
        expect([ihdr.readUInt32BE(0), ihdr.readUInt32BE(4), ihdr[8], ihdr[9]]).toEqual([size, size, 8, 6]);
        const raw = inflateSync(chunks[1]!.data);
        expect(raw.length).toBe(size * (size * 4 + 1));
        // Opaque in the middle, transparent in the rounded corner.
        const alpha = (x: number, y: number) => raw[y * (size * 4 + 1) + 1 + x * 4 + 3];
        expect(alpha(size >> 1, size >> 1)).toBe(255);
        expect(alpha(0, 0)).toBe(0);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
