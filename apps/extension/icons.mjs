/**
 * The extension's icons, drawn in code and written as PNG with node:zlib only:
 * a blue rounded square with a darker calendar band and a white tick.
 * `node icons.mjs <dir>` writes them; build.mjs calls writeIcons.
 */
import { crc32, deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const ICON_SIZES = [16, 32, 48, 128];

const BLUE = [29, 78, 216];
const BAND = [30, 58, 138];
const WHITE = [255, 255, 255];
const SAMPLES = 4;

function insideRoundedSquare(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r);
  const cy = Math.min(Math.max(y, r), 1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

function nearSegment(x, y, [ax, ay], [bx, by], halfWidth) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= halfWidth * halfWidth;
}

/** The colour at a point of the unit square, or undefined outside the icon. */
function paint(x, y) {
  if (!insideRoundedSquare(x, y, 0.2)) return undefined;
  const tick = [[0.27, 0.6], [0.43, 0.75], [0.74, 0.43]];
  if (nearSegment(x, y, tick[0], tick[1], 0.065) || nearSegment(x, y, tick[1], tick[2], 0.065)) return WHITE;
  return y < 0.28 ? BAND : BLUE;
}

/** RGBA pixels, anti-aliased by supersampling. */
export function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      let r = 0, g = 0, b = 0, hits = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const c = paint((col + (sx + 0.5) / SAMPLES) / size, (row + (sy + 0.5) / SAMPLES) / size);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2]; hits++;
        }
      }
      const i = (row * size + col) * 4;
      if (hits) {
        px[i] = Math.round(r / hits);
        px[i + 1] = Math.round(g / hits);
        px[i + 2] = Math.round(b / hits);
        px[i + 3] = Math.round((255 * hits) / (SAMPLES * SAMPLES));
      }
    }
  }
  return px;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGBA PNG: signature, IHDR, one IDAT of unfiltered scanlines, IEND. */
export function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row++) rgba.copy(raw, row * (size * 4 + 1) + 1, row * size * 4, (row + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export function writeIcons(dir) {
  mkdirSync(dir, { recursive: true });
  return ICON_SIZES.map((size) => {
    const file = join(dir, `icon-${size}.png`);
    writeFileSync(file, encodePng(size, drawIcon(size)));
    return file;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(writeIcons(process.argv[2] ?? "icons").join("\n"));
}
