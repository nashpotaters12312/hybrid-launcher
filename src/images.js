// Keeps images small so the library loads and scrolls fast:
//  - covers are downscaled to the size they're displayed at and stored as JPEG
//  - icons are stored as files instead of inline base64 in library.json
const fs = require('fs');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { nativeImage } = require('electron');

const COVER_WIDTH = 600; // largest size a cover is ever shown at (2x for HiDPI)

const toFileUrl = (file) => pathToFileURL(file).href;

function fromFileUrl(url) {
  if (!/^file:/i.test(url || '')) return null;
  try {
    return fileURLToPath(url.replace(/\?.*$/, ''));
  } catch {
    return null;
  }
}

// Returns a smaller JPEG buffer, or the original if it can't be improved.
function optimizeCover(buffer) {
  try {
    let img = nativeImage.createFromBuffer(buffer);
    if (img.isEmpty()) return { data: buffer, ext: null };
    const { width } = img.getSize();
    if (width > COVER_WIDTH) img = img.resize({ width: COVER_WIDTH, quality: 'best' });
    const jpeg = img.toJPEG(85);
    return jpeg.length < buffer.length ? { data: jpeg, ext: '.jpg' } : { data: buffer, ext: null };
  } catch {
    return { data: buffer, ext: null };
  }
}

function writeCover(buffer, dir, baseName, fallbackExt) {
  const { data, ext } = optimizeCover(buffer);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, baseName + (ext || fallbackExt));
  fs.writeFileSync(file, data);
  return toFileUrl(file) + `?v=${Date.now()}`;
}

function saveIcon(dataUrl, dir, id) {
  if (!/^data:image\//.test(dataUrl || '')) return dataUrl || '';
  try {
    const buf = Buffer.from(dataUrl.split(',')[1], 'base64');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.png`);
    fs.writeFileSync(file, buf);
    return toFileUrl(file) + `?v=${Date.now()}`;
  } catch {
    return '';
  }
}

// One-time cleanup for libraries created by older versions.
// Returns true if anything changed.
async function migrateImages(games, { iconsDir, coversDir }) {
  let changed = false;
  for (const g of games) {
    if (/^data:image\//.test(g.icon || '')) {
      g.icon = saveIcon(g.icon, iconsDir, g.id);
      changed = true;
    }
    if (!g.cover || g.coverChecked === g.cover) continue; // already looked at this one
    const file = fromFileUrl(g.cover);
    if (!file || !file.startsWith(path.normalize(coversDir))) continue;
    try {
      const { size } = await fs.promises.stat(file);
      if (size >= 150 * 1024) {
        const buf = await fs.promises.readFile(file);
        const { data, ext } = optimizeCover(buf);
        if (ext) {
          const out = path.join(coversDir, path.basename(file, path.extname(file)) + '-opt' + ext);
          await fs.promises.writeFile(out, data);
          g.cover = toFileUrl(out) + `?v=${Date.now()}`;
          await fs.promises.unlink(file).catch(() => {});
        }
      }
      g.coverChecked = g.cover;
      changed = true;
    } catch {
      /* missing file: the UI will report it and art lookup re-fetches */
    }
    // Yield so the app stays responsive while converting big libraries.
    await new Promise((r) => setImmediate(r));
  }
  return changed;
}

module.exports = { optimizeCover, writeCover, saveIcon, migrateImages, toFileUrl, fromFileUrl };
