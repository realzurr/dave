import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

// ============================================================================
// Pure-JS PNG Encoder (using Node's built-in zlib)
// ============================================================================
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePNG(width, height, rgbaBuffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawScanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    rawScanlines[rowStart] = 0; // filter type 0 (None)
    rgbaBuffer.copy(rawScanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawScanlines);

  return Buffer.concat([
    signature,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ============================================================================
// 1. LZEXE 0.91 Decompressor for DAVE.EXE
// ============================================================================
function unpackLZ91(exeBuf) {
  const sig = exeBuf.subarray(0x1c, 0x20).toString('ascii');
  if (sig !== 'LZ91') {
    throw new Error(`Expected LZ91 signature at 0x1C, got "${sig}"`);
  }
  const hdrPar = exeBuf.readUInt16LE(0x08);
  let si = hdrPar * 16;
  let dx = 16;
  let bp = exeBuf.readUInt16LE(si);
  si += 2;

  function getBit() {
    const bit = bp & 1;
    bp >>= 1;
    if (--dx === 0) {
      bp = exeBuf.readUInt16LE(si);
      si += 2;
      dx = 16;
    }
    return bit;
  }

  const out = [];
  while (true) {
    if (getBit() === 1) {
      out.push(exeBuf[si++]);
    } else {
      let len = 0;
      let span = 0;
      if (getBit() === 0) {
        len = ((getBit() << 1) | getBit()) + 2;
        span = exeBuf[si++] | ~0xff; // -256 .. -1
      } else {
        const low = exeBuf[si++];
        const high = exeBuf[si++];
        len = high & 0x07;
        span = (((high >> 3) | ~0x1f) << 8) | low; // -8192 .. -1
        if (len === 0) {
          len = exeBuf[si++];
          if (len === 0) break; // End of stream
          if (len === 1) continue; // Segment normalization marker
          len += 1;
        } else {
          len += 2;
        }
      }
      for (let i = 0; i < len; i++) {
        out.push(out[out.length + span]);
      }
    }
  }
  return Buffer.from(out);
}

// ============================================================================
// 2. RLE Decompressor for VGA/CGA blocks
// ============================================================================
function unpackRLE(src, offset) {
  const finalLen = src.readUInt32LE(offset);
  let pos = offset + 4;
  const out = Buffer.alloc(finalLen + 512);
  let outPos = 0;
  while (outPos < finalLen) {
    const b = src[pos++];
    if (b & 0x80) {
      const count = 1 + (b & 0x7f);
      src.copy(out, outPos, pos, pos + count);
      pos += count;
      outPos += count;
    } else {
      const count = 3 + b;
      const val = src[pos++];
      out.fill(val, outPos, outPos + count);
      outPos += count;
    }
  }
  return out.subarray(0, finalLen);
}

// ============================================================================
// Main Extraction Pipeline
// ============================================================================
const ROOT = process.cwd();
const EXTRACTED_DIR = path.join(ROOT, 'extracted');
const PUBLIC_ASSETS_DIR = path.join(ROOT, 'public', 'assets');

fs.mkdirSync( path.join(EXTRACTED_DIR, 'sprites', 'vga'), { recursive: true } );
fs.mkdirSync( path.join(EXTRACTED_DIR, 'sprites', 'ui'), { recursive: true } );
fs.mkdirSync( path.join(EXTRACTED_DIR, 'levels'), { recursive: true } );
fs.mkdirSync( path.join(EXTRACTED_DIR, 'sounds'), { recursive: true } );
fs.mkdirSync( PUBLIC_ASSETS_DIR, { recursive: true } );

console.log('1. Reading and unpacking DAVE.EXE (LZ91)...');
const daveExe = fs.readFileSync(path.join(ROOT, 'DAVE.EXE'));
const raw = unpackLZ91(daveExe);
fs.writeFileSync(path.join(EXTRACTED_DIR, 'DAVE_UNPACKED.BIN'), raw);
console.log(`   -> Unpacked code+data size: ${raw.length} bytes (0x${raw.length.toString(16)})`);

// Data Segment base in unpacked image
const DS = 0x254d0;

// ============================================================================
// 3. Extract 256-color VGA Palette (0x2690a .. 0x26c09)
// ============================================================================
console.log('2. Extracting 256-color VGA palette...');
const paletteOffset = 0x2690a;
const palette = [];
for (let i = 0; i < 256; i++) {
  const r6 = raw[paletteOffset + i * 3 + 0];
  const g6 = raw[paletteOffset + i * 3 + 1];
  const b6 = raw[paletteOffset + i * 3 + 2];
  // Convert 6-bit (0..63) to 8-bit (0..255)
  const r = Math.min(255, Math.round((r6 * 255) / 63));
  const g = Math.min(255, Math.round((g6 * 255) / 63));
  const b = Math.min(255, Math.round((b6 * 255) / 63));
  palette.push([r, g, b]);
}

// ============================================================================
// 4. Extract 158 VGA Tiles & Sprites (0x11ef0)
// ============================================================================
console.log('3. Decompressing VGA graphics RLE block (0x11ef0)...');
const vgaData = unpackRLE(raw, 0x11ef0);
const numVgaSprites = vgaData.readUInt32LE(0);
console.log(`   -> Unpacked ${vgaData.length} bytes containing ${numVgaSprites} tiles/sprites.`);

// Map Dave's sprites to their hardware AND-mask sprite index
const daveMaskMap = {
  53: 60, 54: 61, 55: 62, 56: 63, 57: 64, 58: 65, 59: 66,
  67: 69, 68: 70,
  71: 74, 72: 75, 73: 76,
  77: 83, 78: 84, 79: 85, 80: 86, 81: 87, 82: 88,
};
const isMaskSprite = new Set(Object.values(daveMaskMap));

function getRawVgaSprite(idx) {
  const off = vgaData.readUInt32LE(4 + idx * 4);
  const nextOff = (idx + 1 < numVgaSprites) ? vgaData.readUInt32LE(4 + (idx + 1) * 4) : vgaData.length;
  const byteLen = nextOff - off;
  let width = 16;
  let height = 16;
  let pixelStart = off;
  if (byteLen !== 256) {
    if (idx >= 148) {
      width = 8;
      height = 11;
    } else {
      width = vgaData.readUInt16LE(off);
      height = vgaData.readUInt16LE(off + 2);
    }
    pixelStart = off + 4;
  }
  const pixels = vgaData.subarray(pixelStart, pixelStart + width * height);
  return { id: idx, width, height, pixels };
}

const spritesMeta = [];
for (let i = 0; i < numVgaSprites; i++) {
  const sp = getRawVgaSprite(i);
  const maskIdx = daveMaskMap[i];
  const maskSp = maskIdx !== undefined ? getRawVgaSprite(maskIdx) : null;

  const rgba = Buffer.alloc(sp.width * sp.height * 4);
  for (let p = 0; p < sp.width * sp.height; p++) {
    const colorIdx = sp.pixels[p];
    const [r, g, b] = palette[colorIdx];
    let a = 255;

    if (maskSp) {
      // In DAVE.EXE, screen = (screen & mask) | sprite.
      // When mask != 0 (0xff) and sprite == 0, pixel is transparent!
      if (maskSp.pixels[p] !== 0 && colorIdx === 0) {
        a = 0;
      }
    } else if (i >= 89 && i <= 132) {
      // Monsters, fireballs, bullets, explosions: color 0 is transparent
      if (colorIdx === 0) a = 0;
    } else if (i === 0) {
      // Tile 0 is empty black space
      a = 0;
    } else if (i >= 33 && i <= 46 && colorIdx === 0) {
      // Climbable trees/stars/hazards or items with black background remain black/transparent over black playfield
    }

    rgba[p * 4 + 0] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = a;
  }

  const pngBuf = encodePNG(sp.width, sp.height, rgba);
  fs.writeFileSync(path.join(EXTRACTED_DIR, 'sprites', 'vga', `sprite_${String(i).padStart(3, '0')}.png`), pngBuf);

  spritesMeta.push({
    id: i,
    width: sp.width,
    height: sp.height,
    isMask: isMaskSprite.has(i),
    maskId: maskIdx ?? null,
    dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`,
  });
}

// ============================================================================
// 5. Extract 8x8 VGA Font & UI Icons (0x20cc0 .. 0x254d0)
// ============================================================================
console.log('4. Extracting VGA 8x8 Font (128 glyphs) and 13 Control Panel UI Icons...');
const uiBlock = raw.subarray(0x20cc0, 0x254d0);
const fontGlyphs = [];
for (let ch = 0; ch < 128; ch++) {
  const glyphOff = 0x100 + ch * 64;
  const rgba = Buffer.alloc(64 * 4);
  for (let p = 0; p < 64; p++) {
    const colorIdx = uiBlock[glyphOff + p];
    const [r, g, b] = palette[colorIdx];
    // For ASCII text (ch >= 32), color 0 is background (transparent when drawing text)
    const a = (ch >= 32 && colorIdx === 0) ? 0 : 255;
    rgba[p * 4 + 0] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = a;
  }
  const pngBuf = encodePNG(8, 8, rgba);
  fontGlyphs.push({
    charCode: ch,
    dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`,
  });
}

const uiIcons = [];
for (let ic = 0; ic < 13; ic++) {
  const hdrOff = 0x28 + ic * 16;
  const w = uiBlock.readUInt16LE(hdrOff + 0); // 32
  const h = uiBlock.readUInt16LE(hdrOff + 2); // 24
  const name = uiBlock.subarray(hdrOff + 8, hdrOff + 16).toString('ascii').replace(/\0.*$/, '');
  const pixOff = 0x2100 + ic * 768;
  const rgba = Buffer.alloc(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const colorIdx = uiBlock[pixOff + p];
    const [r, g, b] = palette[colorIdx];
    rgba[p * 4 + 0] = r;
    rgba[p * 4 + 1] = g;
    rgba[p * 4 + 2] = b;
    rgba[p * 4 + 3] = 255;
  }
  const pngBuf = encodePNG(w, h, rgba);
  fs.writeFileSync(path.join(EXTRACTED_DIR, 'sprites', 'ui', `icon_${ic}_${name}.png`), pngBuf);
  uiIcons.push({
    id: ic,
    name,
    width: w,
    height: h,
    dataUrl: `data:image/png;base64,${pngBuf.toString('base64')}`,
  });
}

// ============================================================================
// 6. Extract Physics, Collision, Collectible, Warp Zone & Monster Tables from DS
// ============================================================================
console.log('5. Extracting physics, collision, warp zones, and level tables from Data Segment...');

// Jump Y-velocity table (DS:0x00bc, terminated by 128)
const jumpTable = [];
for (let i = 0; i < 64; i++) {
  const val = raw.readInt16LE(DS + 0x00bc + i * 2);
  if (val === 128) break;
  jumpTable.push(val);
}

// Dave initial direction, X, Y per level (0..9)
const daveStart = [];
for (let lvl = 0; lvl < 10; lvl++) {
  const dirFlags = raw[DS + 0x0118 + lvl];
  const x = raw.readUInt16LE(DS + 0x0122 + lvl * 2);
  const y = raw.readUInt16LE(DS + 0x0136 + lvl * 2);
  daveStart.push({ level: lvl + 1, x, y, dirFlags });
}

// Warp zone tables for levels 1..10 (DS:0x016a, 0x017e, 0x0192, 0x01a6)
const warpZones = [];
for (let lvl = 0; lvl < 10; lvl++) {
  const targetMapLevel = raw.readUInt16LE(DS + 0x016a + lvl * 2); // 0 if none, 1-based level index whose right side holds warp zone
  const chuteWallTile = raw.readUInt16LE(DS + 0x017e + lvl * 2);
  const scrollX = raw.readUInt16LE(DS + 0x0192 + lvl * 2);
  const daveX = raw.readUInt16LE(DS + 0x01a6 + lvl * 2);
  warpZones.push({
    fromLevel: lvl + 1,
    hasWarp: targetMapLevel > 0,
    targetMapIndex: targetMapLevel - 1,
    chuteWallTile,
    scrollX,
    daveX,
    daveY: 16,
  });
}

// Collectible tiles (DS:0x023a) and point values (DS:0x024e)
const collectibles = [];
for (let i = 0; i < 10; i++) {
  const tileId = raw.readUInt16LE(DS + 0x023a + i * 2);
  const points = raw.readUInt16LE(DS + 0x024e + i * 2);
  collectibles.push({ tileId, points });
}

// Tile properties for tiles 0..52: climbable (DS:0x0262) and collision (DS:0x02cc: 0=none, 1=solid, 2=deadly)
const tileProperties = [];
for (let t = 0; t < 53; t++) {
  const climbable = raw.readUInt16LE(DS + 0x0262 + t * 2) === 1;
  const collision = raw.readUInt16LE(DS + 0x02cc + t * 2); // 0=passable, 1=solid, 2=hazard
  tileProperties.push({
    tileId: t,
    climbable,
    solid: collision === 1,
    deadly: collision === 2,
  });
}

// Title screen mini-level (10x7 tiles at 0x25ca6)
const titleMap = [];
const titleMapOffset = 0x25ca6;
for (let y = 0; y < 7; y++) {
  const row = [];
  for (let x = 0; x < 10; x++) {
    row.push(raw[titleMapOffset + y * 10 + x]);
  }
  titleMap.push(row);
}

// ============================================================================
// 7. Extract All 10 Levels (0x26c0a .. 0x29e09) + Monster Spawns (0x25966)
// ============================================================================
console.log('6. Extracting all 10 levels and monster patrol paths...');
const levelsStart = 0x26c0a;
const monsterTableStart = 0x25966;
const levels = [];

for (let lvl = 0; lvl < 10; lvl++) {
  const lvlOff = levelsStart + lvl * 1280;
  const pathBytes = raw.subarray(lvlOff, lvlOff + 256);
  const monsterPath = [];
  for (let i = 0; i < 256; i += 2) {
    if (pathBytes[i] === 0xea && pathBytes[i + 1] === 0xea) break;
    monsterPath.push([pathBytes.readInt8(i), pathBytes.readInt8(i + 1)]);
  }

  const tiles = [];
  const mapBytes = raw.subarray(lvlOff + 256, lvlOff + 1256);
  for (let y = 0; y < 10; y++) {
    const row = [];
    for (let x = 0; x < 100; x++) {
      row.push(mapBytes[y * 100 + x]);
    }
    tiles.push(row);
  }

  // Monster spawns for this level (80-byte record at 0x25966 + lvl * 80)
  const mBase = monsterTableStart + lvl * 80;
  const monsters = [];
  const vgaMonsterSpriteBase = lvl >= 2 ? (lvl - 2) * 4 + 89 : 0;
  for (let m = 0; m < 4; m++) {
    const active = raw.readUInt16LE(mBase + m * 2);
    const x = raw.readUInt16LE(mBase + 8 + m * 2);
    const y = raw.readUInt16LE(mBase + 16 + m * 2);
    const pathIndex = raw.readUInt16LE(mBase + 24 + m * 2);
    const fireReload = raw.readUInt16LE(mBase + 32 + m * 2);
    if (active === 1) {
      monsters.push({
        id: m,
        x,
        y,
        pathIndex,
        fireReload,
        spriteBase: vgaMonsterSpriteBase,
      });
    }
  }

  const levelObj = {
    level: lvl + 1,
    daveStart: daveStart[lvl],
    warpZone: warpZones[lvl],
    monsters,
    monsterPath,
    tiles,
  };
  levels.push(levelObj);
  fs.writeFileSync(
    path.join(EXTRACTED_DIR, 'levels', `level_${lvl + 1}.json`),
    JSON.stringify(levelObj, null, 2)
  );
}

// ============================================================================
// 8. Extract PC Speaker Sounds (0x1c2e0 "SPK\0")
// ============================================================================
console.log('7. Extracting 12 PC Speaker sound effects (0x1c2e0)...');
const spkBlock = raw.subarray(0x1c2e0, 0x1d580);
const sounds = [];
for (let i = 1; i <= 12; i++) {
  const ent = spkBlock.subarray(i * 16, (i + 1) * 16);
  const off = ent.readUInt16LE(0);
  const priority = ent[2];
  const timerRate = ent[3]; // PIT rate multiplier (sample rate = 18.2065 * timerRate Hz)
  const name = ent.subarray(4, 16).toString('ascii').replace(/\0.*$/, '');
  const divisors = [];
  for (let p = off; p < spkBlock.length; p += 2) {
    const w = spkBlock.readUInt16LE(p);
    if (w === 0xffff) break;
    divisors.push(w);
  }
  sounds.push({
    id: i,
    name,
    priority,
    timerRate,
    sampleRateHz: +(18.2065 * Math.max(1, timerRate)).toFixed(2),
    divisors,
  });
}
fs.writeFileSync(path.join(EXTRACTED_DIR, 'sounds', 'sounds.json'), JSON.stringify(sounds, null, 2));

// ============================================================================
// 9. Extract High Scores from DSCORES.DAV
// ============================================================================
console.log('8. Extracting High Scores from DSCORES.DAV...');
const highScores = [];
const dscoresPath = path.join(ROOT, 'DSCORES.DAV');
if (fs.existsSync(dscoresPath)) {
  const hsBuf = fs.readFileSync(dscoresPath);
  // 5 entries of 9 bytes each: uint32_le score (or level + score + 3-char name)
  // Let's check exact layout in DAVE.EXE at 0xa820:
  for (let i = 0; i < 5 && (i + 1) * 9 <= hsBuf.length; i++) {
    const rec = hsBuf.subarray(i * 9, (i + 1) * 9);
    const level = rec[0];
    const score =
      rec[1] * 10000 +
      rec[2] * 1000 +
      rec[3] * 100 +
      rec[4] * 10 +
      rec[5];
    const name = rec.subarray(6, 9).toString('ascii').replace(/\0.*$/, '');
    highScores.push({ rank: i + 1, score, level, name });
  }
}

// ============================================================================
// 10. Write Unified Bundle to public/assets/gamedata.json
// ============================================================================
const gameData = {
  meta: {
    game: 'Dangerous Dave (1990)',
    author: 'John Romero / Softdisk, Inc.',
    unpackedExeSize: raw.length,
    extractedAt: new Date().toISOString(),
  },
  palette,
  sprites: spritesMeta,
  fontGlyphs,
  uiIcons,
  physics: {
    jumpTable,
    collectibles,
    tileProperties,
  },
  titleMap,
  levels,
  sounds,
  highScores,
};

const outPath = path.join(PUBLIC_ASSETS_DIR, 'gamedata.json');
fs.writeFileSync(outPath, JSON.stringify(gameData));
console.log(`9. Wrote unified web asset bundle to ${outPath} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);
console.log('Done!');
