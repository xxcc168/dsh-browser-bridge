// 生成扩展图标（零依赖 PNG 编码器：圆角蓝底 + 白色桥形图案）
"use strict";

const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(size * stride);
  const s = size;
  const radius = s * 0.22;
  for (let y = 0; y < s; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < s; x++) {
      const o = y * stride + 1 + x * 4;
      // 圆角矩形判定
      const cx = Math.max(radius, Math.min(x, s - 1 - radius));
      const cy = Math.max(radius, Math.min(y, s - 1 - radius));
      if (Math.hypot(x - cx, y - cy) > radius) {
        raw[o] = 0;
        raw[o + 1] = 0;
        raw[o + 2] = 0;
        raw[o + 3] = 0;
        continue;
      }
      // 背景：纵向渐变蓝
      const t = y / s;
      let r = Math.round(30 + (13 - 30) * t);
      let g = Math.round(90 + (110 - 90) * t);
      let b = Math.round(200 + (253 - 200) * t);
      // 白色“桥”：桥面 + 两个桥墩
      const deck = y >= s * 0.44 && y <= s * 0.56;
      const p1 = x >= s * 0.22 && x <= s * 0.32 && y >= s * 0.56 && y <= s * 0.78;
      const p2 = x >= s * 0.68 && x <= s * 0.78 && y >= s * 0.56 && y <= s * 0.78;
      if (deck || p1 || p2) {
        r = 255;
        g = 255;
        b = 255;
      }
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const outDir = path.join(__dirname, "..", "extension", "icons");
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const p = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(p, makePng(size));
  console.log("生成", p);
}
