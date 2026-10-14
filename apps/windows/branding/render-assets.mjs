// Renders the app's icon, window logo and MSIX tile images from SVG.
// Run from the repo root after changing the artwork:
//   node apps/windows/branding/render-assets.mjs
// Uses sharp from the site's devDependencies.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..", "TalosDiagnostic", "Assets");
const pkgDir = join(here, "..", "Package", "Assets");
const repoRoot = join(here, "..", "..", "..");

const tileSvg = await readFile(join(here, "app-icon.svg"));
const markSvg = await readFile(join(repoRoot, "public", "brand-logo", "talos-int-icon-dark.svg"));
const BG = "#1a1b26";

const png = (svg, size) => sharp(svg, { density: 1200 }).resize(size, size).png().toBuffer();

// Hexagon mark centred on a dark background of any shape (Start tiles).
async function onBackground(width, height, iconSize) {
  const icon = await png(markSvg, iconSize);
  return sharp({ create: { width, height, channels: 4, background: BG } })
    .composite([{ input: icon, left: Math.round((width - iconSize) / 2), top: Math.round((height - iconSize) / 2) }])
    .png()
    .toBuffer();
}

// ICO with PNG-compressed images (supported since Windows Vista): a fraction
// of the size of the BMP entries most converters write.
function pngIco(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

async function save(dir, name, buffer) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), buffer);
  console.log("wrote", join(dir, name));
}

// Window header logo (transparent, shown at 48 px on the dark window).
await save(appDir, "logo.png", await png(markSvg, 96));

// Executable icon (also used by the window title bar and taskbar).
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoImages = await Promise.all(icoSizes.map(async (size) => ({ size, data: await png(tileSvg, size) })));
await save(appDir, "talos.ico", pngIco(icoImages));

// MSIX visual assets (resources.pri picks the right scale at install time).
for (const [scale, factor] of [["100", 1], ["200", 2]]) {
  await save(pkgDir, `Square44x44Logo.scale-${scale}.png`, await png(tileSvg, 44 * factor));
  await save(pkgDir, `Square150x150Logo.scale-${scale}.png`, await onBackground(150 * factor, 150 * factor, 120 * factor));
  await save(pkgDir, `Wide310x150Logo.scale-${scale}.png`, await onBackground(310 * factor, 150 * factor, 120 * factor));
  await save(pkgDir, `StoreLogo.scale-${scale}.png`, await png(tileSvg, 50 * factor));
}
// Taskbar / Start list icons at exact sizes, without the accent plate.
for (const size of [16, 24, 32, 48, 256]) {
  const buffer = await png(tileSvg, size);
  await save(pkgDir, `Square44x44Logo.targetsize-${size}.png`, buffer);
  await save(pkgDir, `Square44x44Logo.targetsize-${size}_altform-unplated.png`, buffer);
}
