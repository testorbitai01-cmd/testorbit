import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf: Buffer): number {
  let crc = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

function makeChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function decodePng(filePath: string) {
  const buf = fs.readFileSync(filePath);
  const w = buf.readUInt32BE(16);
  const h = buf.readUInt32BE(20);
  let offset = 8;
  const idats: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idats.push(buf.subarray(offset + 8, offset + 8 + len));
    offset += 12 + len;
  }
  const decompressed = zlib.inflateSync(Buffer.concat(idats));
  return { w, h, decompressed };
}

function encodePng(w: number, h: number, rgbaData: Buffer): Buffer {
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Add 0 filter byte before each row
  const scanlines = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    const destOffset = y * (w * 4 + 1);
    scanlines[destOffset] = 0; // Filter None
    rgbaData.copy(scanlines, destOffset + 1, y * w * 4, (y + 1) * w * 4);
  }

  const compressed = zlib.deflateSync(scanlines);
  return Buffer.concat([
    header,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function crop(src: { w: number; h: number; decompressed: Buffer }, cropX: number, cropY: number, cropW: number, cropH: number, invertDark = false) {
  const out = Buffer.alloc(cropW * cropH * 4);
  const srcStride = src.w * 4 + 1;

  for (let y = 0; y < cropH; y++) {
    const srcY = cropY + y;
    const srcLineStart = srcY * srcStride + 1;
    for (let x = 0; x < cropW; x++) {
      const srcX = cropX + x;
      const srcPx = srcLineStart + srcX * 4;
      const destPx = (y * cropW + x) * 4;

      let r = src.decompressed[srcPx]!;
      let g = src.decompressed[srcPx + 1]!;
      let b = src.decompressed[srcPx + 2]!;
      const a = src.decompressed[srcPx + 3]!;

      if (invertDark && a > 10) {
        // If the pixel is dark (black/gray text), turn it to crisp white for dark sidebar
        // Note: Blue elements have high blue and low red/green (e.g. #0066FF)
        const isBlue = b > 150 && r < 100 && g < 150;
        if (!isBlue && r < 80 && g < 80 && b < 80) {
          r = 255;
          g = 255;
          b = 255;
        }
      }

      out[destPx] = r;
      out[destPx + 1] = g;
      out[destPx + 2] = b;
      out[destPx + 3] = a;
    }
  }
  return encodePng(cropW, cropH, out);
}

const logoSource = 'C:/Users/karth/.gemini/antigravity-ide/brain/3dba00e3-1684-4452-947d-ac0a7d18e9cd/.user_uploaded/media_1791141129544.png';
const faviconSource = 'C:/Users/karth/.gemini/antigravity-ide/brain/3dba00e3-1684-4452-947d-ac0a7d18e9cd/.user_uploaded/media_1791141177951.png';

const publicDir = path.resolve('client/public');
fs.mkdirSync(publicDir, { recursive: true });

// 1. Process Logo
// Bounds: x: 90 to 405 y: 206 to 293 w: 316 h: 88
const logoDecoded = decodePng(logoSource);
// Crop with 4px padding
const logoCropX = 86;
const logoCropY = 202;
const logoCropW = 324;
const logoCropH = 96;

const logoLight = crop(logoDecoded, logoCropX, logoCropY, logoCropW, logoCropH, false);
fs.writeFileSync(path.join(publicDir, 'logo.png'), logoLight);
console.log('Saved client/public/logo.png');

const logoDark = crop(logoDecoded, logoCropX, logoCropY, logoCropW, logoCropH, true);
fs.writeFileSync(path.join(publicDir, 'logo-dark.png'), logoDark);
console.log('Saved client/public/logo-dark.png');

// 2. Process Favicon
// Bounds: x: 168 to 308 y: 168 to 309 w: 141 h: 142
const favDecoded = decodePng(faviconSource);
// Make it square 148x148
const favCropX = 164;
const favCropY = 165;
const favCropSize = 148;

const faviconPng = crop(favDecoded, favCropX, favCropY, favCropSize, favCropSize, false);
fs.writeFileSync(path.join(publicDir, 'favicon.png'), faviconPng);
fs.writeFileSync(path.join(publicDir, 'favicon.ico'), faviconPng); // Modern browsers happily read PNG inside .ico or direct
console.log('Saved client/public/favicon.png and favicon.ico');

// Also save raw uncropped copies
fs.writeFileSync(path.join(publicDir, 'logo-full.png'), fs.readFileSync(logoSource));
fs.writeFileSync(path.join(publicDir, 'icon-full.png'), fs.readFileSync(faviconSource));
console.log('All brand assets processed successfully!');
