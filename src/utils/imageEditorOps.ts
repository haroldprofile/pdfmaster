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
