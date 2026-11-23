// Shared pure helpers for Image Tools (ID Photo Sheet math + EXIF/PNG metadata parser)

export interface IdPhotoPreset {
  id: string;
  label: string;
  sublabel: string;
  widthMm: number;
  heightMm: number;
  widthPx: number;  // at 300 DPI
  heightPx: number; // at 300 DPI
}

export interface SheetPreset {
  id: string;
  label: string;
  widthMm: number;
  heightMm: number;
  widthPx: number;  // at 300 DPI
  heightPx: number; // at 300 DPI
  widthPt: number;  // PDF points (72 pt/in)
  heightPt: number;
}

const MM_TO_PX_300 = 300 / 25.4;
const MM_TO_PT = 72 / 25.4;

export const ID_PRESETS: IdPhotoPreset[] = [
  {
    id: '2x2',
    label: '2 × 2 in',
    sublabel: '50.8 × 50.8 mm (PH / US ID)',
    widthMm: 50.8,
    heightMm: 50.8,
    widthPx: 600,
    heightPx: 600,
  },
  {
    id: '1x1',
    label: '1 × 1 in',
    sublabel: '25.4 × 25.4 mm (Small ID)',
    widthMm: 25.4,
    heightMm: 25.4,
    widthPx: 300,
    heightPx: 300,
  },
  {
    id: 'passport',
    label: 'Passport',
    sublabel: '35 × 45 mm (ICAO / EU / PH)',
    widthMm: 35,
    heightMm: 45,
    widthPx: Math.round(35 * MM_TO_PX_300),
    heightPx: Math.round(45 * MM_TO_PX_300),
  },
  {
    id: 'wallet',
    label: 'Wallet 2.5×3.5',
    sublabel: '63.5 × 88.9 mm',
    widthMm: 63.5,
    heightMm: 88.9,
    widthPx: 750,
    heightPx: 1050,
  },
];

export const SHEET_PRESETS: SheetPreset[] = [
  {
    id: '4r',
    label: '4R (4 × 6 in)',
    widthMm: 101.6,
    heightMm: 152.4,
    widthPx: 1200,
    heightPx: 1800,
    widthPt: 288,
    heightPt: 432,
  },
  {
    id: '5r',
    label: '5R (5 × 7 in)',
    widthMm: 127,
    heightMm: 177.8,
    widthPx: 1500,
    heightPx: 2100,
    widthPt: 360,
    heightPt: 504,
  },
  {
    id: 'a4',
    label: 'A4 (210 × 297 mm)',
    widthMm: 210,
    heightMm: 297,
    widthPx: Math.round(210 * MM_TO_PX_300),
    heightPx: Math.round(297 * MM_TO_PX_300),
    widthPt: Math.round(210 * MM_TO_PT),
    heightPt: Math.round(297 * MM_TO_PT),
  },
];

export interface SheetCell {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IdSheetLayout {
  sheet: SheetPreset;
  preset: IdPhotoPreset;
  cols: number;
  rows: number;
  totalCopies: number;
  cells: SheetCell[];
}

/**
 * Computes centered multi-copy ID grid positions on a printable 300-DPI sheet.
 */
export function computeIdSheetLayout(
  presetId: string,
  sheetId: string,
  gapMm = 3,
  marginMm = 5
): IdSheetLayout {
  const preset = ID_PRESETS.find(p => p.id === presetId) || ID_PRESETS[0];
  const sheet = SHEET_PRESETS.find(s => s.id === sheetId) || SHEET_PRESETS[0];

  const gapPx = Math.round(gapMm * MM_TO_PX_300);
  const marginPx = Math.round(marginMm * MM_TO_PX_300);
  const availW = Math.max(preset.widthPx, sheet.widthPx - marginPx * 2);
  const availH = Math.max(preset.heightPx, sheet.heightPx - marginPx * 2);

  const cols = Math.max(1, Math.floor((availW + gapPx) / (preset.widthPx + gapPx)));
  const rows = Math.max(1, Math.floor((availH + gapPx) / (preset.heightPx + gapPx)));

  const gridW = cols * preset.widthPx + (cols - 1) * gapPx;
  const gridH = rows * preset.heightPx + (rows - 1) * gapPx;
  const startX = Math.max(0, Math.floor((sheet.widthPx - gridW) / 2));
  const startY = Math.max(0, Math.floor((sheet.heightPx - gridH) / 2));

  const cells: SheetCell[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      cells.push({
        x: startX + c * (preset.widthPx + gapPx),
        y: startY + r * (preset.heightPx + gapPx),
        w: preset.widthPx,
        h: preset.heightPx,
      });
    }
  }

  return { sheet, preset, cols, rows, totalCopies: cells.length, cells };
}

// ─── Pure Binary EXIF / PNG Metadata Parser ───────────────────────

export interface ParsedImageMetadata {
  hasExif: boolean;
  hasGps: boolean;
  gps?: { lat: number; lon: number };
  tags: Array<{ key: string; value: string; sensitive?: boolean }>;
}

const IFD0_TAGS: Record<number, string> = {
  0x010f: 'Camera Make',
  0x0110: 'Camera Model',
  0x0112: 'Orientation',
  0x0131: 'Software',
  0x0132: 'Date Modified',
  0x013b: 'Artist / Author',
  0x8298: 'Copyright',
};

const EXIF_SUB_TAGS: Record<number, string> = {
  0x829a: 'Exposure Time',
  0x829d: 'Aperture (F-Number)',
  0x8827: 'ISO Speed',
  0x9003: 'Date Taken',
  0x920a: 'Focal Length',
  0xa434: 'Lens Model',
};

function readAscii(view: DataView, offset: number, length: number): string {
  let out = '';
  const end = Math.min(view.byteLength, offset + length);
  for (let i = offset; i < end; i++) {
    const ch = view.getUint8(i);
    if (ch === 0) break;
    if (ch >= 32 && ch <= 126) out += String.fromCharCode(ch);
  }
  return out.trim();
}

function readRational(view: DataView, offset: number, littleEndian: boolean): number | null {
  if (offset + 8 > view.byteLength) return null;
  const num = view.getUint32(offset, littleEndian);
  const den = view.getUint32(offset + 4, littleEndian);
  return den === 0 ? null : num / den;
}

function parseIfdEntries(
  view: DataView,
  tiffStart: number,
  ifdOffset: number,
  littleEndian: boolean
): Map<number, { type: number; count: number; valueOffset: number; rawValuePos: number }> {
  const map = new Map<number, { type: number; count: number; valueOffset: number; rawValuePos: number }>();
  const pos = tiffStart + ifdOffset;
  if (pos + 2 > view.byteLength) return map;
  const count = view.getUint16(pos, littleEndian);
  const typeSizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  for (let i = 0; i < count; i++) {
    const entryPos = pos + 2 + i * 12;
    if (entryPos + 12 > view.byteLength) break;
    const tag = view.getUint16(entryPos, littleEndian);
    const type = view.getUint16(entryPos + 2, littleEndian);
    const numValues = view.getUint32(entryPos + 4, littleEndian);
    const byteSize = (typeSizes[type] || 1) * numValues;
    const rawValuePos = byteSize <= 4
      ? entryPos + 8
      : tiffStart + view.getUint32(entryPos + 8, littleEndian);
    const valueOffset = view.getUint32(entryPos + 8, littleEndian);
    map.set(tag, { type, count: numValues, valueOffset, rawValuePos });
  }
  return map;
}

function formatTagValue(
  view: DataView,
  entry: { type: number; count: number; rawValuePos: number },
  littleEndian: boolean,
  tagId: number
): string | null {
  const { type, count, rawValuePos } = entry;
  if (rawValuePos < 0 || rawValuePos >= view.byteLength) return null;

  if (type === 2) {
    const txt = readAscii(view, rawValuePos, count);
    return txt || null;
  }
  if (type === 3 && rawValuePos + 2 <= view.byteLength) {
    return String(view.getUint16(rawValuePos, littleEndian));
  }
  if (type === 4 && rawValuePos + 4 <= view.byteLength) {
    return String(view.getUint32(rawValuePos, littleEndian));
  }
  if (type === 5) {
    const val = readRational(view, rawValuePos, littleEndian);
    if (val === null) return null;
    if (tagId === 0x829a && val > 0 && val < 1) return `1/${Math.round(1 / val)} s`;
    if (tagId === 0x829d) return `f/${val.toFixed(1)}`;
    if (tagId === 0x920a) return `${val.toFixed(1)} mm`;
    return val.toFixed(2);
  }
  return null;
}

/**
 * Pure binary parser for JPEG EXIF/GPS (APP1) and PNG text chunks (tEXt).
 * // ponytail: covers JPEG APP1 EXIF/GPS & PNG tEXt without pulling a 100KB exifr dependency
 */
export function parseImageMetadata(buffer: ArrayBuffer): ParsedImageMetadata {
  const view = new DataView(buffer);
  const tags: ParsedImageMetadata['tags'] = [];
  let hasExif = false;
  let hasGps = false;
  let gps: { lat: number; lon: number } | undefined;

  if (view.byteLength < 12) {
    return { hasExif: false, hasGps: false, tags };
  }

  // Check JPEG signature (0xFFD8)
  if (view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) break; // SOS / EOI
      const segLen = view.getUint16(offset + 2);
      if (segLen < 2) break;

      // APP1 Exif header: "Exif\0\0"
      if (marker === 0xe1 && offset + 10 <= view.byteLength) {
        const hdr = readAscii(view, offset + 4, 4);
        if (hdr === 'Exif') {
          hasExif = true;
          const tiffStart = offset + 10;
          if (tiffStart + 8 <= view.byteLength) {
            const byteOrder = view.getUint16(tiffStart);
            const littleEndian = byteOrder === 0x4949; // 'II'
            if (byteOrder === 0x4949 || byteOrder === 0x4d4d) {
              const firstIfd = view.getUint32(tiffStart + 4, littleEndian);
              const ifd0 = parseIfdEntries(view, tiffStart, firstIfd, littleEndian);

              for (const [tagId, label] of Object.entries(IFD0_TAGS)) {
                const entry = ifd0.get(Number(tagId));
                if (!entry) continue;
                const val = formatTagValue(view, entry, littleEndian, Number(tagId));
                if (val) {
                  tags.push({
                    key: label,
                    value: val,
                    sensitive: Number(tagId) === 0x013b || Number(tagId) === 0x010f || Number(tagId) === 0x0110,
                  });
                }
              }

              // Exif SubIFD (0x8769)
              const exifPtr = ifd0.get(0x8769);
              if (exifPtr) {
                const subIfd = parseIfdEntries(view, tiffStart, exifPtr.valueOffset, littleEndian);
                for (const [tagId, label] of Object.entries(EXIF_SUB_TAGS)) {
                  const entry = subIfd.get(Number(tagId));
                  if (!entry) continue;
                  const val = formatTagValue(view, entry, littleEndian, Number(tagId));
                  if (val) tags.push({ key: label, value: val });
                }
              }

              // GPS IFD (0x8825)
              const gpsPtr = ifd0.get(0x8825);
              if (gpsPtr) {
                const gpsIfd = parseIfdEntries(view, tiffStart, gpsPtr.valueOffset, littleEndian);
                const latRefEntry = gpsIfd.get(0x0001);
                const latEntry = gpsIfd.get(0x0002);
                const lonRefEntry = gpsIfd.get(0x0003);
                const lonEntry = gpsIfd.get(0x0004);
                if (latEntry && lonEntry && latEntry.count >= 3 && lonEntry.count >= 3) {
                  const latD = readRational(view, latEntry.rawValuePos, littleEndian);
                  const latM = readRational(view, latEntry.rawValuePos + 8, littleEndian);
                  const latS = readRational(view, latEntry.rawValuePos + 16, littleEndian);
                  const lonD = readRational(view, lonEntry.rawValuePos, littleEndian);
                  const lonM = readRational(view, lonEntry.rawValuePos + 8, littleEndian);
                  const lonS = readRational(view, lonEntry.rawValuePos + 16, littleEndian);
                  if (latD !== null && latM !== null && latS !== null && lonD !== null && lonM !== null && lonS !== null) {
                    const latRef = latRefEntry ? readAscii(view, latRefEntry.rawValuePos, 2) : 'N';
                    const lonRef = lonRefEntry ? readAscii(view, lonRefEntry.rawValuePos, 2) : 'E';
                    const lat = (latD + latM / 60 + latS / 3600) * (latRef === 'S' ? -1 : 1);
                    const lon = (lonD + lonM / 60 + lonS / 3600) * (lonRef === 'W' ? -1 : 1);
                    hasGps = true;
                    gps = { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) };
                    tags.unshift({
                      key: 'GPS Coordinates',
                      value: `${gps.lat}, ${gps.lon}`,
                      sensitive: true,
                    });
                  }
                }
              }
            }
          }
          break;
        }
      }
      offset += 2 + segLen;
    }
    return { hasExif, hasGps, gps, tags };
  }

  // Check PNG signature (89 50 4E 47) and scan tEXt chunks
  if (view.getUint32(0) === 0x89504e47) {
    let offset = 8;
    while (offset + 12 <= view.byteLength) {
      const len = view.getUint32(offset);
      const chunkType = readAscii(view, offset + 4, 4);
      if (chunkType === 'tEXt' && len > 0 && offset + 8 + len <= view.byteLength) {
        hasExif = true;
        const dataStart = offset + 8;
        let sep = -1;
        for (let i = 0; i < len; i++) {
          if (view.getUint8(dataStart + i) === 0) { sep = i; break; }
        }
        if (sep > 0) {
          const k = readAscii(view, dataStart, sep);
          const v = readAscii(view, dataStart + sep + 1, len - sep - 1);
          if (k && v) tags.push({ key: `PNG: ${k}`, value: v.slice(0, 140) });
        }
      }
      if (chunkType === 'eXIf') hasExif = true;
      if (chunkType === 'IEND') break;
      offset += 12 + len;
    }
  }

  return { hasExif, hasGps, gps, tags };
}
