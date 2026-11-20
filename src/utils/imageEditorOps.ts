// Pure HTML5 Canvas 2D pixel processing helpers for ImageEditorTool

export type ScanMode = 'none' | 'clean-scan' | 'crisp-bw' | 'photocopy';

export interface ScanOptions {
  mode: ScanMode;
  threshold: number; // 0..255 (default 145)
  contrast: number;  // 0.5..3.0 (default 1.8)
  grain: number;     // 0..100 (default 18 for photocopy)
}

function clampByte(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Applies scanned-document B&W / photocopy effects in-place on RGBA pixel buffer.
 * - clean-scan: O(W*H) integral-image local illumination normalization flattens shadows
 *   into crisp white paper while preserving sharp dark text (CamScanner / Adobe Scan look).
 * - crisp-bw: global high-contrast B&W with soft anti-aliased transition band.
 * - photocopy: grayscale photocopy contrast + deterministic paper grain + subtle edge vignette.
 */
export function applyScanEffect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options: ScanOptions
): void {
  const { mode, threshold, contrast, grain } = options;
  if (mode === 'none') return;

  const total = width * height;
  const lum = new Float32Array(total);
  for (let i = 0; i < total; i++) {
    const p = i << 2;
    lum[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  if (mode === 'clean-scan') {
    // Build (width+1) x (height+1) summed-area table for O(1) local box mean
    const stride = width + 1;
    const sat = new Float64Array(stride * (height + 1));
    for (let y = 0; y < height; y++) {
      let rowSum = 0;
      const rowOff = y * width;
      const satCurr = (y + 1) * stride;
      const satPrev = y * stride;
      for (let x = 0; x < width; x++) {
        rowSum += lum[rowOff + x];
        sat[satCurr + x + 1] = sat[satPrev + x + 1] + rowSum;
      }
    }

    const radius = Math.max(8, Math.min(48, Math.round(Math.min(width, height) * 0.03)));
    // Threshold (0..255) shifts ink sensitivity; higher threshold pulls darker grays to black
    const pivot = 0.72 + ((threshold - 128) / 255) * 0.45;
    const steepness = 3.5 * contrast;

    for (let y = 0; y < height; y++) {
      const y0 = Math.max(0, y - radius);
      const y1 = Math.min(height - 1, y + radius);
      const satY0 = y0 * stride;
      const satY1 = (y1 + 1) * stride;
      const rowOff = y * width;

      for (let x = 0; x < width; x++) {
        const x0 = Math.max(0, x - radius);
        const x1 = Math.min(width - 1, x + radius);
        const area = (x1 - x0 + 1) * (y1 - y0 + 1);
        const localMean = (
          sat[satY1 + x1 + 1] - sat[satY0 + x1 + 1] - sat[satY1 + x0] + sat[satY0 + x0]
        ) / area;

        // Normalize pixel against local illumination so shadows become pure white
        const l = lum[rowOff + x];
        const ratio = localMean > 8 ? l / localMean : l / 255;
        const val = clampByte(Math.round((0.5 + (ratio - pivot) * steepness) * 255));
        const p = (rowOff + x) << 2;
        data[p] = data[p + 1] = data[p + 2] = val;
      }
    }
    return;
  }

  if (mode === 'crisp-bw') {
    const slope = contrast * 2.2;
    for (let i = 0; i < total; i++) {
      const val = clampByte(Math.round(128 + (lum[i] - threshold) * slope));
      const p = i << 2;
      data[p] = data[p + 1] = data[p + 2] = val;
    }
    return;
  }

  // 'photocopy': crisp grayscale + deterministic grain + subtle edge vignette
  const cx = width * 0.5;
  const cy = height * 0.5;
  const invR2 = 1 / (cx * cx + cy * cy || 1);
  const grainAmp = grain * 0.65;
  const slope = contrast * 1.45;

  for (let y = 0; y < height; y++) {
    const dy = y - cy;
    const dy2 = dy * dy;
    const rowOff = y * width;
    for (let x = 0; x < width; x++) {
      const idx = rowOff + x;
      const dx = x - cx;
      const distNorm = (dx * dx + dy2) * invR2;
      // Subtle photocopy paper edge darkening
      const vignette = 1 - distNorm * 0.14;
      // Fast deterministic spatial hash in [-0.5, 0.5]
      let h = Math.imul(idx ^ 0x9e3779b9, 0x85ebca6b);
      h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
      const noise = (((h ^ (h >>> 16)) >>> 0) / 0xffffffff - 0.5) * grainAmp;

      const contrasted = 128 + (lum[idx] - threshold) * slope;
      const val = clampByte(Math.round(contrasted * vignette + noise));
      const p = idx << 2;
      data[p] = data[p + 1] = data[p + 2] = val;
    }
  }
}

/**
 * 3x3 unsharp-mask convolution kernel (amount: 0..100).
 */
export function applySharpen(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  amount: number
): void {
  if (amount <= 0 || width < 3 || height < 3) return;
  const k = (amount / 100) * 1.25;
  const src = new Uint8ClampedArray(data);
  const rowStride = width * 4;

  for (let y = 1; y < height - 1; y++) {
    const row = y * rowStride;
    for (let x = 1; x < width - 1; x++) {
      const p = row + x * 4;
      for (let c = 0; c < 3; c++) {
        const center = src[p + c];
        const neighbors =
          src[p - rowStride + c] +
          src[p + rowStride + c] +
          src[p - 4 + c] +
          src[p + 4 + c];
        data[p + c] = clampByte(Math.round(center + k * (4 * center - neighbors)));
      }
    }
  }
}

/**
 * Removes background pixels matching the color at (startX, startY).
 * - contiguous=true: iterative BFS flood-fill (stack-safe on 4K images) with 1px soft feathering.
 * - contiguous=false: global color-key removal (erases trapped holes inside letters/logos).
 * Returns the number of pixels modified.
 */
export function applyMagicWandErase(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  startX: number,
  startY: number,
  tolerance: number,
  contiguous: boolean
): number {
  const sx = Math.max(0, Math.min(width - 1, Math.round(startX)));
  const sy = Math.max(0, Math.min(height - 1, Math.round(startY)));
  const startIdx = (sy * width + sx) << 2;
  if (data[startIdx + 3] === 0) return 0;

  const tr = data[startIdx];
  const tg = data[startIdx + 1];
  const tb = data[startIdx + 2];

  // Max Euclidean RGB distance is sqrt(3 * 255^2) ≈ 441.67
  const hardDist = (tolerance / 100) * 260;
  const softDist = hardDist + 18;
  const hardDist2 = hardDist * hardDist;
  const softDist2 = softDist * softDist;

  let modified = 0;

  if (!contiguous) {
    const total = width * height;
    for (let i = 0; i < total; i++) {
      const p = i << 2;
      if (data[p + 3] === 0) continue;
      const dr = data[p] - tr;
      const dg = data[p + 1] - tg;
      const db = data[p + 2] - tb;
      const d2 = dr * dr + dg * dg + db * db;
      if (d2 <= hardDist2) {
        data[p + 3] = 0;
        modified++;
      } else if (d2 < softDist2) {
        const factor = (Math.sqrt(d2) - hardDist) / (softDist - hardDist);
        data[p + 3] = Math.round(data[p + 3] * factor);
        modified++;
      }
    }
    return modified;
  }

  // Contiguous BFS flood-fill using flat typed arrays
  const total = width * height;
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let head = 0;
  let tail = 0;

  const startFlat = sy * width + sx;
  visited[startFlat] = 1;
  queue[tail++] = startFlat;

  while (head < tail) {
    const curr = queue[head++];
    const p = curr << 2;
    const dr = data[p] - tr;
    const dg = data[p + 1] - tg;
    const db = data[p + 2] - tb;
    const d2 = dr * dr + dg * dg + db * db;

    if (d2 <= hardDist2) {
      data[p + 3] = 0;
      modified++;
    } else if (d2 < softDist2) {
      const factor = (Math.sqrt(d2) - hardDist) / (softDist - hardDist);
      data[p + 3] = Math.round(data[p + 3] * factor);
      modified++;
      continue; // Feather boundary — don't expand past soft edge
    } else {
      continue;
    }

    const x = curr % width;
    const y = (curr - x) / width;

    if (x > 0 && !visited[curr - 1]) { visited[curr - 1] = 1; queue[tail++] = curr - 1; }
    if (x + 1 < width && !visited[curr + 1]) { visited[curr + 1] = 1; queue[tail++] = curr + 1; }
    if (y > 0 && !visited[curr - width]) { visited[curr - width] = 1; queue[tail++] = curr - width; }
    if (y + 1 < height && !visited[curr + width]) { visited[curr + width] = 1; queue[tail++] = curr + width; }
  }

  return modified;
}

/**
 * Pixelates (mosaic privacy blur) a circular region directly on a 2D canvas context.
 */
export function applyMosaicRegion(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  blockSize = 12
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  const x0 = Math.max(0, Math.floor((cx - radius) / blockSize) * blockSize);
  const y0 = Math.max(0, Math.floor((cy - radius) / blockSize) * blockSize);
  const x1 = Math.min(w, Math.ceil((cx + radius) / blockSize) * blockSize);
  const y1 = Math.min(h, Math.ceil((cy + radius) / blockSize) * blockSize);
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw <= 0 || rh <= 0) return;

  const img = ctx.getImageData(x0, y0, rw, rh);
  const d = img.data;
  const r2 = radius * radius;

  for (let by = 0; by < rh; by += blockSize) {
    for (let bx = 0; bx < rw; bx += blockSize) {
      const midX = x0 + bx + blockSize * 0.5 - cx;
      const midY = y0 + by + blockSize * 0.5 - cy;
      if (midX * midX + midY * midY > r2) continue;

      const bw = Math.min(blockSize, rw - bx);
      const bh = Math.min(blockSize, rh - by);
      let r = 0, g = 0, b = 0, a = 0, count = 0;

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          const p = ((by + dy) * rw + (bx + dx)) << 2;
          r += d[p]; g += d[p + 1]; b += d[p + 2]; a += d[p + 3];
          count++;
        }
      }
      if (!count) continue;
      const ar = Math.round(r / count);
      const ag = Math.round(g / count);
      const ab = Math.round(b / count);
      const aa = Math.round(a / count);

      for (let dy = 0; dy < bh; dy++) {
        for (let dx = 0; dx < bw; dx++) {
          const p = ((by + dy) * rw + (bx + dx)) << 2;
          d[p] = ar; d[p + 1] = ag; d[p + 2] = ab; d[p + 3] = aa;
        }
      }
    }
  }
  ctx.putImageData(img, x0, y0);
}

export interface Point2D {
  x: number;
  y: number;
}

/** Ordered document corners: [topLeft, topRight, bottomRight, bottomLeft] */
export type QuadCorners = [Point2D, Point2D, Point2D, Point2D];

export const DEFAULT_QUAD: QuadCorners = [
  { x: 0.08, y: 0.08 },
  { x: 0.92, y: 0.08 },
  { x: 0.92, y: 0.92 },
  { x: 0.08, y: 0.92 },
];

function cross2D(o: Point2D, a: Point2D, b: Point2D): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

function quadArea(q: Point2D[]): number {
  let sum = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i];
    const b = q[(i + 1) % q.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

/**
 * Orders 4 arbitrary corner points clockwise starting from Top-Left: [TL, TR, BR, BL].
 */
export function orderQuadCorners(pts: Point2D[]): QuadCorners {
  const cx = (pts[0].x + pts[1].x + pts[2].x + pts[3].x) / 4;
  const cy = (pts[0].y + pts[1].y + pts[2].y + pts[3].y) / 4;
  // Sort clockwise in screen coords (y increases downward => ascending atan2)
  const sorted = [...pts].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx)
  );
  // Rotate so the vertex closest to top-left (min x + y) is index 0
  let tlIdx = 0;
  let minSum = Infinity;
  for (let i = 0; i < 4; i++) {
    const s = sorted[i].x + sorted[i].y;
    if (s < minSum) {
      minSum = s;
      tlIdx = i;
    }
  }
  return [
    sorted[tlIdx],
    sorted[(tlIdx + 1) % 4],
    sorted[(tlIdx + 2) % 4],
    sorted[(tlIdx + 3) % 4],
  ];
}

/** Andrew's monotone chain 2D convex hull */
function convexHull(points: Point2D[]): Point2D[] {
  if (points.length <= 3) return points;
  const pts = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const lower: Point2D[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2D(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point2D[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2D(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Simplifies a convex polygon down to its best-fitting 4-corner quadrilateral */
function simplifyHullToQuad(hull: Point2D[]): QuadCorners | null {
  if (hull.length < 4) return null;
  const poly = [...hull];
  while (poly.length > 4) {
    let minArea = Infinity;
    let dropIdx = 0;
    const n = poly.length;
    for (let i = 0; i < n; i++) {
      const prev = poly[(i - 1 + n) % n];
      const curr = poly[i];
      const next = poly[(i + 1) % n];
      const triArea = Math.abs(cross2D(prev, curr, next)) * 0.5;
      if (triArea < minArea) {
        minArea = triArea;
        dropIdx = i;
      }
    }
    poly.splice(dropIdx, 1);
  }
  return orderQuadCorners(poly);
}

/**
 * Automatically detects the 4 corners of a photographed document (normalized 0..1).
 * Uses downscaled Otsu border-aware blob segmentation + Sobel edge fallback +
 * convex-hull 4-vertex simplification. Zero external CV dependencies.
 * // ponytail: pure-TS Otsu+Sobel hull detector (~15ms); swap for OpenCV/ML only if cluttered multi-paper scenes fail
 */
export function detectDocumentCorners(
  data: Uint8ClampedArray,
  width: number,
  height: number
): { corners: QuadCorners; detected: boolean } {
  if (width < 20 || height < 20) {
    return { corners: DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners, detected: false };
  }

  // Downscale to <= 260px on longest side for fast, noise-resistant detection
  const maxDim = 260;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const sw = Math.max(16, Math.round(width * scale));
  const sh = Math.max(16, Math.round(height * scale));
  const total = sw * sh;

  const gray = new Float32Array(total);
  for (let y = 0; y < sh; y++) {
    const sy = Math.min(height - 1, Math.floor((y / sh) * height));
    for (let x = 0; x < sw; x++) {
      const sx = Math.min(width - 1, Math.floor((x / sw) * width));
      const p = (sy * width + sx) << 2;
      gray[y * sw + x] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
  }

  // 3x3 box blur to suppress text lines & table grain
  const blurred = new Float32Array(total);
  for (let y = 0; y < sh; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(sh - 1, y + 1);
    for (let x = 0; x < sw; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(sw - 1, x + 1);
      blurred[y * sw + x] = (
        gray[ym * sw + xm] + gray[ym * sw + x] + gray[ym * sw + xp] +
        gray[y  * sw + xm] + gray[y  * sw + x] + gray[y  * sw + xp] +
        gray[yp * sw + xm] + gray[yp * sw + x] + gray[yp * sw + xp]
      ) / 9;
    }
  }

  // Otsu threshold on blurred luminance
  const hist = new Uint32Array(256);
  for (let i = 0; i < total; i++) hist[clampByte(Math.round(blurred[i]))]++;
  let sumAll = 0;
  for (let t = 0; t < 256; t++) sumAll += t * hist[t];

  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let otsu = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      otsu = t;
    }
  }

  // Compare outer border ring luminance vs center to determine bright-on-dark vs dark-on-light
  let borderSum = 0, borderCount = 0;
  let centerSum = 0, centerCount = 0;
  const padX = Math.max(2, Math.floor(sw * 0.05));
  const padY = Math.max(2, Math.floor(sh * 0.05));
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const v = blurred[y * sw + x];
      if (x < padX || x >= sw - padX || y < padY || y >= sh - padY) {
        borderSum += v; borderCount++;
      } else if (x > sw * 0.25 && x < sw * 0.75 && y > sh * 0.25 && y < sh * 0.75) {
        centerSum += v; centerCount++;
      }
    }
  }
  const brightDoc = (centerSum / (centerCount || 1)) >= (borderSum / (borderCount || 1));

  // Build binary foreground mask & find largest connected component via BFS
  const mask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    mask[i] = brightDoc ? (blurred[i] >= otsu ? 1 : 0) : (blurred[i] <= otsu ? 1 : 0);
  }

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  let bestPixels: number[] = [];

  for (let i = 0; i < total; i++) {
    if (!mask[i] || visited[i]) continue;
    let head = 0, tail = 0;
    visited[i] = 1;
    queue[tail++] = i;
    const comp: number[] = [];

    while (head < tail) {
      const curr = queue[head++];
      comp.push(curr);
      const x = curr % sw;
      const y = (curr - x) / sw;
      if (x > 0 && mask[curr - 1] && !visited[curr - 1]) { visited[curr - 1] = 1; queue[tail++] = curr - 1; }
      if (x + 1 < sw && mask[curr + 1] && !visited[curr + 1]) { visited[curr + 1] = 1; queue[tail++] = curr + 1; }
      if (y > 0 && mask[curr - sw] && !visited[curr - sw]) { visited[curr - sw] = 1; queue[tail++] = curr - sw; }
      if (y + 1 < sh && mask[curr + sw] && !visited[curr + sw]) { visited[curr + sw] = 1; queue[tail++] = curr + sw; }
    }
    if (comp.length > bestPixels.length) bestPixels = comp;
  }

  const blobFrac = bestPixels.length / total;
  let candidatePoints: Point2D[] = [];

  if (blobFrac >= 0.08 && blobFrac <= 0.94) {
    // Extract boundary pixels of the largest blob
    const inBest = new Uint8Array(total);
    for (let i = 0; i < bestPixels.length; i++) inBest[bestPixels[i]] = 1;
    for (let i = 0; i < bestPixels.length; i++) {
      const idx = bestPixels[i];
      const x = idx % sw;
      const y = (idx - x) / sw;
      if (
        x === 0 || x === sw - 1 || y === 0 || y === sh - 1 ||
        !inBest[idx - 1] || !inBest[idx + 1] || !inBest[idx - sw] || !inBest[idx + sw]
      ) {
        candidatePoints.push({ x, y });
      }
    }
  } else {
    // Fallback: Sobel gradient magnitude strong-edge cloud (handles low-contrast desks)
    const mag = new Float32Array(total);
    let maxMag = 0;
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        const gx =
          -blurred[(y - 1) * sw + (x - 1)] + blurred[(y - 1) * sw + (x + 1)]
          - 2 * blurred[y * sw + (x - 1)] + 2 * blurred[y * sw + (x + 1)]
          - blurred[(y + 1) * sw + (x - 1)] + blurred[(y + 1) * sw + (x + 1)];
        const gy =
          -blurred[(y - 1) * sw + (x - 1)] - 2 * blurred[(y - 1) * sw + x] - blurred[(y - 1) * sw + (x + 1)]
          + blurred[(y + 1) * sw + (x - 1)] + 2 * blurred[(y + 1) * sw + x] + blurred[(y + 1) * sw + (x + 1)];
        const m = Math.hypot(gx, gy);
        mag[y * sw + x] = m;
        if (m > maxMag) maxMag = m;
      }
    }
    const edgeThresh = maxMag * 0.25;
    if (edgeThresh > 12) {
      for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
          if (mag[y * sw + x] >= edgeThresh) {
            candidatePoints.push({ x, y });
          }
        }
      }
    }
  }

  if (candidatePoints.length >= 4) {
    const hull = convexHull(candidatePoints);
    const quad = simplifyHullToQuad(hull);
    if (quad) {
      const areaFrac = quadArea(quad) / total;
      if (areaFrac >= 0.08 && areaFrac <= 0.98) {
        const norm = quad.map(p => ({
          x: Math.max(0, Math.min(1, p.x / (sw - 1))),
          y: Math.max(0, Math.min(1, p.y / (sh - 1))),
        })) as QuadCorners;
        return { corners: norm, detected: true };
      }
    }
  }

  return { corners: DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners, detected: false };
}

/**
 * Solves 3x3 homography mapping 4 destination corners -> 4 source corners
 * via 8x8 Gaussian elimination with partial pivoting.
 */
function solveHomography(dst: QuadCorners, src: QuadCorners): Float64Array | null {
  const A: number[][] = [];
  const b: number[] = [];

  for (let i = 0; i < 4; i++) {
    const x = dst[i].x, y = dst[i].y;
    const u = src[i].x, v = src[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    let maxAbs = Math.abs(A[col][col]);
    for (let r = col + 1; r < n; r++) {
      const val = Math.abs(A[r][col]);
      if (val > maxAbs) { maxAbs = val; pivotRow = r; }
    }
    if (maxAbs < 1e-10) return null;
    if (pivotRow !== col) {
      [A[col], A[pivotRow]] = [A[pivotRow], A[col]];
      [b[col], b[pivotRow]] = [b[pivotRow], b[col]];
    }
    const diag = A[col][col];
    for (let c = col; c < n; c++) A[col][c] /= diag;
    b[col] /= diag;

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f === 0) continue;
      for (let c = col; c < n; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }

  return new Float64Array([b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], 1]);
}

/**
 * Pure RGBA projective perspective warp (bilinear interpolation) from a 4-corner quad
 * into a flat upright rectangle. Corners are in pixel coordinates [TL, TR, BR, BL].
 */
export function warpRgbaPerspective(
  srcData: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  cornersPx: QuadCorners
): { data: Uint8ClampedArray; width: number; height: number } {
  const [tl, tr, br, bl] = orderQuadCorners(cornersPx);
  const topW = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const botW = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftH = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightH = Math.hypot(br.x - tr.x, br.y - tr.y);

  const outW = Math.max(16, Math.min(4096, Math.round(Math.max(topW, botW))));
  const outH = Math.max(16, Math.min(4096, Math.round(Math.max(leftH, rightH))));

  const dstQuad: QuadCorners = [
    { x: 0, y: 0 },
    { x: outW - 1, y: 0 },
    { x: outW - 1, y: outH - 1 },
    { x: 0, y: outH - 1 },
  ];

  const H = solveHomography(dstQuad, [tl, tr, br, bl]);
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (!H) return { data: out, width: outW, height: outH };

  const h0 = H[0], h1 = H[1], h2 = H[2];
  const h3 = H[3], h4 = H[4], h5 = H[5];
  const h6 = H[6], h7 = H[7];
  const maxX = srcW - 1;
  const maxY = srcH - 1;

  for (let y = 0; y < outH; y++) {
    const rowOut = y * outW;
    const h1y = h1 * y + h2;
    const h4y = h4 * y + h5;
    const h7y = h7 * y + 1;

    for (let x = 0; x < outW; x++) {
      const denom = h6 * x + h7y;
      const u = (h0 * x + h1y) / denom;
      const v = (h3 * x + h4y) / denom;
      const outP = (rowOut + x) << 2;

      if (u < 0 || v < 0 || u > maxX || v > maxY) {
        out[outP] = out[outP + 1] = out[outP + 2] = 255;
        out[outP + 3] = 255;
        continue;
      }

      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 < maxX ? x0 + 1 : maxX;
      const y1 = y0 < maxY ? y0 + 1 : maxY;
      const fx = u - x0;
      const fy = v - y0;
      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      const p00 = (y0 * srcW + x0) << 2;
      const p10 = (y0 * srcW + x1) << 2;
      const p01 = (y1 * srcW + x0) << 2;
      const p11 = (y1 * srcW + x1) << 2;

      out[outP]     = Math.round(srcData[p00]     * w00 + srcData[p10]     * w10 + srcData[p01]     * w01 + srcData[p11]     * w11);
      out[outP + 1] = Math.round(srcData[p00 + 1] * w00 + srcData[p10 + 1] * w10 + srcData[p01 + 1] * w01 + srcData[p11 + 1] * w11);
      out[outP + 2] = Math.round(srcData[p00 + 2] * w00 + srcData[p10 + 2] * w10 + srcData[p01 + 2] * w01 + srcData[p11 + 2] * w11);
      out[outP + 3] = Math.round(srcData[p00 + 3] * w00 + srcData[p10 + 3] * w10 + srcData[p01 + 3] * w01 + srcData[p11 + 3] * w11);
    }
  }

  return { data: out, width: outW, height: outH };
}
