import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, Undo2, Redo2, RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2,
  SlidersHorizontal, ScanLine, Crop, Eraser, Pencil, Maximize2, Download,
  Eye, KeyRound, Sparkles, Wand2, Trash2, Loader2, Check, X, Lock, Unlock,
  FileText, Image as ImageIcon, Type, Square, Minus, MoveUpRight, Grid3x3,
  AlertCircle, CheckCircle2
} from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import {
  applyScanEffect,
  applySharpen,
  applyMagicWandErase,
  applyMosaicRegion,
  detectDocumentCorners,
  warpRgbaPerspective,
  DEFAULT_QUAD,
  type ScanMode,
  type QuadCorners
} from '../utils/imageEditorOps';

type EditorTab = 'adjust' | 'scan' | 'crop' | 'bg' | 'draw' | 'resize';
type CropMode = 'rect' | 'corners';
type DrawTool = 'pen' | 'mosaic' | 'text' | 'rect' | 'line' | 'arrow';
type BgMode = 'transparent' | 'solid' | 'image';
type AspectPreset = 'free' | '1:1' | '4:3' | '16:9' | 'a4' | 'id';

interface Adjustments {
  brightness: number; // 0..200 (100 default)
  contrast: number;   // 0..200 (100 default)
  saturation: number; // 0..200 (100 default)
  sharpness: number;  // 0..100 (0 default)
  straighten: number; // -45..45 (0 default)
}

interface ScanSettings {
  mode: ScanMode;
  threshold: number;
  contrast: number;
  grain: number;
}

interface CropRect {
  x: number; // 0..1 normalized
  y: number;
  w: number;
  h: number;
}

const DEFAULT_ADJ: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  sharpness: 0,
  straighten: 0,
};

const DEFAULT_SCAN: ScanSettings = {
  mode: 'none',
  threshold: 145,
  contrast: 1.8,
  grain: 20,
};

const ASPECT_RATIOS: Record<AspectPreset, { label: string; ratio: number | null }> = {
  free:   { label: 'Free',   ratio: null },
  '1:1':  { label: '1:1',    ratio: 1 },
  '4:3':  { label: '4:3',    ratio: 4 / 3 },
  '16:9': { label: '16:9',   ratio: 16 / 9 },
  a4:     { label: 'A4',     ratio: 210 / 297 },
  id:     { label: 'ID 2×2', ratio: 1 },
};

const SOLID_BG_SWATCHES = [
  { label: 'White', color: '#FFFFFF' },
  { label: 'ID Blue', color: '#2563EB' },
  { label: 'Light Gray', color: '#F1F5F9' },
  { label: 'Red', color: '#DC2626' },
  { label: 'Black', color: '#0F172A' },
];

// ponytail: 15-step canvas snapshot stack; switch to compressed blobs if 8K images need deeper history
const MAX_HISTORY = 15;
const API_KEY_STORAGE = 'pdfmaster_withoutbg_api_key';

function cloneCanvas(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d');
  if (ctx) ctx.drawImage(src, 0, 0);
  return c;
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  size: number
) {
  const headLen = Math.max(12, size * 3.5);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

export default function ImageEditorTool() {
  const apiHost = import.meta.env.VITE_API_URL || 'https://pdfmaster-backend-thhj.onrender.com';

  // Core image & canvas refs
  const [hasImage, setHasImage] = useState(false);
  const [fileName, setFileName] = useState('edited-image');
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [isDraggingFile, setIsDraggingFile] = useState(false);

  const originalCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const bgImgInputRef = useRef<HTMLInputElement | null>(null);

  // History
  const historyRef = useRef<HTMLCanvasElement[]>([]);
  const historyIdxRef = useRef<number>(-1);
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const [renderTick, setRenderTick] = useState(0);

  // UI tabs & modes
  const [activeTab, setActiveTab] = useState<EditorTab>('adjust');
  const [comparing, setComparing] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null);

  // Adjust & Scan states
  const [adj, setAdj] = useState<Adjustments>(DEFAULT_ADJ);
  const [scan, setScan] = useState<ScanSettings>(DEFAULT_SCAN);

  // Crop state (rectangle + 4-corner perspective flatten)
  const [cropMode, setCropMode] = useState<CropMode>('rect');
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
  const [aspectPreset, setAspectPreset] = useState<AspectPreset>('free');
  const cropDragRef = useRef<{
    handle: 'move' | 'nw' | 'ne' | 'sw' | 'se';
    startX: number;
    startY: number;
    startRect: CropRect;
  } | null>(null);
  const [quadCorners, setQuadCorners] = useState<QuadCorners>(
    () => DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners
  );
  const quadDragIdxRef = useRef<number | null>(null);

  // Remove BG & Background replacement state
  const [serverHasKey, setServerHasKey] = useState<boolean | null>(null);
  const [userApiKey, setUserApiKey] = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || '');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [magicWandActive, setMagicWandActive] = useState(false);
  const [wandTolerance, setWandTolerance] = useState(24);
  const [wandContiguous, setWandContiguous] = useState(true);
  const [bgMode, setBgMode] = useState<BgMode>('transparent');
  const [bgColor, setBgColor] = useState('#FFFFFF');
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

  // Draw / Annotate state
  const [drawTool, setDrawTool] = useState<DrawTool>('pen');
  const [drawColor, setDrawColor] = useState('#EF4444');
  const [drawSize, setDrawSize] = useState(6);
  const [textValue, setTextValue] = useState('CONFIDENTIAL');
  const [textSize, setTextSize] = useState(36);
  const drawStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    snapshot: HTMLCanvasElement | null;
  }>({ active: false, startX: 0, startY: 0, lastX: 0, lastY: 0, snapshot: null });

  // Resize state
  const [resizeW, setResizeW] = useState(0);
  const [resizeH, setResizeH] = useState(0);
  const [lockAspect, setLockAspect] = useState(true);

  // Export quality
  const [jpgQuality, setJpgQuality] = useState(92);

  // Check server /api/health once on mount
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    fetch(`${apiHost}/api/health`, { signal: ctrl.signal })
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (data && typeof data.hasWithoutBgKey === 'boolean') {
          setServerHasKey(data.hasWithoutBgKey);
        } else {
          setServerHasKey(false);
        }
      })
      .catch(() => setServerHasKey(false))
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [apiHost]);

  const syncHistoryState = useCallback(() => {
    setHistoryState({
      canUndo: historyIdxRef.current > 0,
      canRedo: historyIdxRef.current < historyRef.current.length - 1,
    });
  }, []);

  const pushHistory = useCallback((canvas: HTMLCanvasElement) => {
    const next = historyRef.current.slice(0, historyIdxRef.current + 1);
    next.push(cloneCanvas(canvas));
    if (next.length > MAX_HISTORY) next.shift();
    historyRef.current = next;
    historyIdxRef.current = next.length - 1;
    setDims({ w: canvas.width, h: canvas.height });
    setResizeW(canvas.width);
    setResizeH(canvas.height);
    syncHistoryState();
    setRenderTick(t => t + 1);
  }, [syncHistoryState]);

  const loadImageSource = useCallback((img: HTMLImageElement, name: string) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return;

    const orig = document.createElement('canvas');
    orig.width = w;
    orig.height = h;
    orig.getContext('2d')?.drawImage(img, 0, 0);

    originalCanvasRef.current = orig;
    baseCanvasRef.current = cloneCanvas(orig);
    historyRef.current = [cloneCanvas(orig)];
    historyIdxRef.current = 0;

    setFileName(name.replace(/\.[^.]+$/, '') || 'edited-image');
    setDims({ w, h });
    setResizeW(w);
    setResizeH(h);
    setAdj(DEFAULT_ADJ);
    setScan(DEFAULT_SCAN);
    setBgMode('transparent');
    setBgImage(null);
    setCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    setQuadCorners(DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners);
    setAspectPreset('free');
    setStatusMsg(null);
    setHasImage(true);
    syncHistoryState();
    setRenderTick(t => t + 1);
  }, [syncHistoryState]);

  const handleFileList = useCallback((files: FileList | null) => {
    if (!files || !files.length) return;
    const file = files[0];
    if (!file.type.startsWith('image/')) {
      setStatusMsg({ type: 'error', text: 'Please select an image file (PNG, JPG, WebP, or BMP).' });
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      loadImageSource(img, file.name);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatusMsg({ type: 'error', text: 'Could not decode that image file.' });
    };
    img.src = url;
  }, [loadImageSource]);

  // Clipboard Ctrl+V paste support
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (!blob) continue;
          const url = URL.createObjectURL(blob);
          const img = new Image();
          img.onload = () => {
            loadImageSource(img, 'pasted-image.png');
            URL.revokeObjectURL(url);
          };
          img.src = url;
          break;
        }
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [loadImageSource]);

  // Composite full canvas (shared by live display + final export + bake)
  const renderComposite = useCallback((target: HTMLCanvasElement, includeBg: boolean) => {
    const base = baseCanvasRef.current;
    if (!base) return;
    const w = base.width;
    const h = base.height;
    target.width = w;
    target.height = h;
    const ctx = target.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.clearRect(0, 0, w, h);

    // 1. Optional background layer behind transparent subject
    if (includeBg) {
      if (bgMode === 'solid') {
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, w, h);
      } else if (bgMode === 'image' && bgImage) {
        // Cover-fit background image
        const scale = Math.max(w / bgImage.width, h / bgImage.height);
        const dw = bgImage.width * scale;
        const dh = bgImage.height * scale;
        ctx.drawImage(bgImage, (w - dw) / 2, (h - dh) / 2, dw, dh);
      }
    }

    // 2. Subject with CSS adjustments + optional straighten rotation
    const subjectCanvas = document.createElement('canvas');
    subjectCanvas.width = w;
    subjectCanvas.height = h;
    const sctx = subjectCanvas.getContext('2d', { willReadFrequently: true });
    if (!sctx) return;

    sctx.filter = `brightness(${adj.brightness}%) contrast(${adj.contrast}%) saturate(${adj.saturation}%)`;
    if (adj.straighten !== 0) {
      const rad = (adj.straighten * Math.PI) / 180;
      // Auto-scale slightly so corners don't leave empty triangles when straightening
      const absCos = Math.abs(Math.cos(rad));
      const absSin = Math.abs(Math.sin(rad));
      const scale = Math.max((w * absCos + h * absSin) / w, (w * absSin + h * absCos) / h);
      sctx.translate(w / 2, h / 2);
      sctx.rotate(rad);
      sctx.scale(scale, scale);
      sctx.drawImage(base, -w / 2, -h / 2);
    } else {
      sctx.drawImage(base, 0, 0);
    }
    sctx.filter = 'none';

    // 3. Pixel passes: Sharpen + Scanned Copy B&W
    if (adj.sharpness > 0 || scan.mode !== 'none') {
      const imgData = sctx.getImageData(0, 0, w, h);
      if (adj.sharpness > 0) {
        applySharpen(imgData.data, w, h, adj.sharpness);
      }
      if (scan.mode !== 'none') {
        applyScanEffect(imgData.data, w, h, scan);
      }
      sctx.putImageData(imgData, 0, 0);
    }

    ctx.drawImage(subjectCanvas, 0, 0);
  }, [adj, scan, bgMode, bgColor, bgImage]);

  // Re-render visible display canvas whenever anything changes
  useEffect(() => {
    if (!hasImage || !displayCanvasRef.current) return;
    if (comparing && originalCanvasRef.current) {
      const orig = originalCanvasRef.current;
      const disp = displayCanvasRef.current;
      disp.width = orig.width;
      disp.height = orig.height;
      disp.getContext('2d')?.drawImage(orig, 0, 0);
      return;
    }
    renderComposite(displayCanvasRef.current, true);
  }, [hasImage, comparing, renderComposite, renderTick]);

  // Bake live adjustments/scan into baseCanvas before destructive ops (Crop / Draw)
  const bakePendingFilters = useCallback((includeBg = false) => {
    const base = baseCanvasRef.current;
    if (!base) return;
    const hasPending =
      adj.brightness !== 100 ||
      adj.contrast !== 100 ||
      adj.saturation !== 100 ||
      adj.sharpness !== 0 ||
      adj.straighten !== 0 ||
      scan.mode !== 'none' ||
      (includeBg && bgMode !== 'transparent');

    if (!hasPending) return;
    const baked = document.createElement('canvas');
    renderComposite(baked, includeBg);
    baseCanvasRef.current = baked;
    setAdj(DEFAULT_ADJ);
    setScan(DEFAULT_SCAN);
    if (includeBg) setBgMode('transparent');
  }, [adj, scan, bgMode, renderComposite]);

  // ── History Actions ──
  const handleUndo = () => {
    if (historyIdxRef.current <= 0) return;
    historyIdxRef.current -= 1;
    const snap = cloneCanvas(historyRef.current[historyIdxRef.current]);
    baseCanvasRef.current = snap;
    setDims({ w: snap.width, h: snap.height });
    setResizeW(snap.width);
    setResizeH(snap.height);
    syncHistoryState();
    setRenderTick(t => t + 1);
  };

  const handleRedo = () => {
    if (historyIdxRef.current >= historyRef.current.length - 1) return;
    historyIdxRef.current += 1;
    const snap = cloneCanvas(historyRef.current[historyIdxRef.current]);
    baseCanvasRef.current = snap;
    setDims({ w: snap.width, h: snap.height });
    setResizeW(snap.width);
    setResizeH(snap.height);
    syncHistoryState();
    setRenderTick(t => t + 1);
  };

  const handleResetAll = () => {
    if (!originalCanvasRef.current) return;
    const fresh = cloneCanvas(originalCanvasRef.current);
    baseCanvasRef.current = fresh;
    setAdj(DEFAULT_ADJ);
    setScan(DEFAULT_SCAN);
    setBgMode('transparent');
    setBgImage(null);
    setCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    setQuadCorners(DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners);
    setStatusMsg({ type: 'info', text: 'Reset to original image.' });
    pushHistory(fresh);
  };

  // ── Transforms (Rotate ±90° & Flip) ──
  const applyTransform = (type: 'rot-l' | 'rot-r' | 'flip-h' | 'flip-v') => {
    const base = baseCanvasRef.current;
    if (!base) return;
    const c = document.createElement('canvas');
    const isRot = type === 'rot-l' || type === 'rot-r';
    c.width = isRot ? base.height : base.width;
    c.height = isRot ? base.width : base.height;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.translate(c.width / 2, c.height / 2);
    if (type === 'rot-l') ctx.rotate(-Math.PI / 2);
    if (type === 'rot-r') ctx.rotate(Math.PI / 2);
    if (type === 'flip-h') ctx.scale(-1, 1);
    if (type === 'flip-v') ctx.scale(1, -1);
    ctx.drawImage(base, -base.width / 2, -base.height / 2);
    baseCanvasRef.current = c;
    pushHistory(c);
  };

  // ── Crop Helpers ──
  const selectAspectPreset = (preset: AspectPreset) => {
    setAspectPreset(preset);
    const ratio = ASPECT_RATIOS[preset].ratio;
    if (!ratio || !dims.w || !dims.h) return;
    const imgRatio = dims.w / dims.h;
    // Compute centered normalized crop box matching target aspect ratio
    let w = 0.8;
    let h = (w * imgRatio) / ratio;
    if (h > 0.85) {
      h = 0.85;
      w = (h * ratio) / imgRatio;
    }
    w = Math.min(1, w);
    h = Math.min(1, h);
    setCropRect({ x: (1 - w) / 2, y: (1 - h) / 2, w, h });
  };

  const startCropDrag = (
    e: React.PointerEvent,
    handle: 'move' | 'nw' | 'ne' | 'sw' | 'se'
  ) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    cropDragRef.current = {
      handle,
      startX: e.clientX,
      startY: e.clientY,
      startRect: { ...cropRect },
    };
  };

  const onCropPointerMove = (e: React.PointerEvent) => {
    const drag = cropDragRef.current;
    const canvas = displayCanvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    const dx = (e.clientX - drag.startX) / rect.width;
    const dy = (e.clientY - drag.startY) / rect.height;
    const sr = drag.startRect;
    const minSize = 0.05;
    const ratio = ASPECT_RATIOS[aspectPreset].ratio;
    const imgRatio = dims.w && dims.h ? dims.w / dims.h : 1;

    if (drag.handle === 'move') {
      const nx = Math.max(0, Math.min(1 - sr.w, sr.x + dx));
      const ny = Math.max(0, Math.min(1 - sr.h, sr.y + dy));
      setCropRect({ ...sr, x: nx, y: ny });
      return;
    }

    let x1 = sr.x;
    let y1 = sr.y;
    let x2 = sr.x + sr.w;
    let y2 = sr.y + sr.h;

    if (drag.handle.includes('w')) x1 = Math.max(0, Math.min(x2 - minSize, sr.x + dx));
    if (drag.handle.includes('e')) x2 = Math.min(1, Math.max(x1 + minSize, sr.x + sr.w + dx));
    if (drag.handle.includes('n')) y1 = Math.max(0, Math.min(y2 - minSize, sr.y + dy));
    if (drag.handle.includes('s')) y2 = Math.min(1, Math.max(y1 + minSize, sr.y + sr.h + dy));

    let nw = x2 - x1;
    let nh = y2 - y1;

    if (ratio) {
      // Lock normalized box to target pixel aspect ratio
      nh = (nw * imgRatio) / ratio;
      if (drag.handle.includes('n')) {
        y1 = y2 - nh;
        if (y1 < 0) { y1 = 0; nh = y2; nw = (nh * ratio) / imgRatio; }
      } else if (y1 + nh > 1) {
        nh = 1 - y1;
        nw = (nh * ratio) / imgRatio;
      }
      if (drag.handle.includes('w')) {
        x1 = Math.max(0, x2 - nw);
      }
    }

    setCropRect({ x: x1, y: y1, w: Math.min(1 - x1, nw), h: Math.min(1 - y1, nh) });
  };

  const endCropDrag = () => {
    cropDragRef.current = null;
  };

  const applyCrop = () => {
    bakePendingFilters(false);
    const base = baseCanvasRef.current;
    if (!base) return;
    const sx = Math.round(cropRect.x * base.width);
    const sy = Math.round(cropRect.y * base.height);
    const sw = Math.max(1, Math.round(cropRect.w * base.width));
    const sh = Math.max(1, Math.round(cropRect.h * base.height));

    const cropped = document.createElement('canvas');
    cropped.width = sw;
    cropped.height = sh;
    cropped.getContext('2d')?.drawImage(base, sx, sy, sw, sh, 0, 0, sw, sh);
    baseCanvasRef.current = cropped;
    setCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
    setQuadCorners(DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners);
    pushHistory(cropped);
    setStatusMsg({ type: 'success', text: `Cropped to ${sw} × ${sh} px.` });
  };

  // ── 4-Corner Document Auto-Detect & Perspective Flatten ──
  const handleAutoDetectCorners = () => {
    const base = baseCanvasRef.current;
    if (!base) return;
    const ctx = base.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const imgData = ctx.getImageData(0, 0, base.width, base.height);
    const { corners, detected } = detectDocumentCorners(imgData.data, base.width, base.height);
    setQuadCorners(corners);
    setCropMode('corners');
    setActiveTab('crop');
    setStatusMsg(
      detected
        ? { type: 'success', text: 'Document corners detected! Drag any corner to fine-tune, then click Flatten & Crop.' }
        : { type: 'info', text: 'Could not lock onto clear page edges — drag the 4 corner handles manually.' }
    );
  };

  const startQuadCornerDrag = (e: React.PointerEvent, idx: number) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    quadDragIdxRef.current = idx;
  };

  const onQuadPointerMove = (e: React.PointerEvent) => {
    const idx = quadDragIdxRef.current;
    const canvas = displayCanvasRef.current;
    if (idx === null || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const nx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const ny = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setQuadCorners(prev => {
      const next = prev.map(p => ({ ...p })) as QuadCorners;
      next[idx] = { x: nx, y: ny };
      return next;
    });
  };

  const endQuadCornerDrag = () => {
    quadDragIdxRef.current = null;
  };

  const applyPerspectiveCrop = () => {
    bakePendingFilters(false);
    const base = baseCanvasRef.current;
    if (!base) return;
    const ctx = base.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const cornersPx = quadCorners.map(p => ({
      x: p.x * (base.width - 1),
      y: p.y * (base.height - 1),
    })) as QuadCorners;

    const srcData = ctx.getImageData(0, 0, base.width, base.height).data;
    const warped = warpRgbaPerspective(srcData, base.width, base.height, cornersPx);

    const outCanvas = document.createElement('canvas');
    outCanvas.width = warped.width;
    outCanvas.height = warped.height;
    const outCtx = outCanvas.getContext('2d');
    if (outCtx) {
      const outImg = outCtx.createImageData(warped.width, warped.height);
      outImg.data.set(warped.data);
      outCtx.putImageData(outImg, 0, 0);
    }

    baseCanvasRef.current = outCanvas;
    setQuadCorners(DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners);
    pushHistory(outCanvas);
    setStatusMsg({ type: 'success', text: `Document flattened & cropped to ${warped.width} × ${warped.height} px.` });
  };

  // ── Resize ──
  const handleResizeWidthChange = (val: number) => {
    const w = Math.max(1, Math.min(8000, val || 1));
    setResizeW(w);
    if (lockAspect && dims.w > 0) {
      setResizeH(Math.max(1, Math.round((w * dims.h) / dims.w)));
    }
  };

  const handleResizeHeightChange = (val: number) => {
    const h = Math.max(1, Math.min(8000, val || 1));
    setResizeH(h);
    if (lockAspect && dims.h > 0) {
      setResizeW(Math.max(1, Math.round((h * dims.w) / dims.h)));
    }
  };

  const applyResize = () => {
    const base = baseCanvasRef.current;
    if (!base || resizeW < 1 || resizeH < 1) return;
    const resized = document.createElement('canvas');
    resized.width = resizeW;
    resized.height = resizeH;
    const ctx = resized.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(base, 0, 0, resizeW, resizeH);
    }
    baseCanvasRef.current = resized;
    pushHistory(resized);
    setStatusMsg({ type: 'success', text: `Resized to ${resizeW} × ${resizeH} px.` });
  };

  // ── AI Remove Background (withoutBG Cloud API via Express proxy) ──
  const handleAiRemoveBg = async () => {
    const base = baseCanvasRef.current;
    if (!base) return;
    setIsRemovingBg(true);
    setStatusMsg({ type: 'info', text: 'Sending image to withoutBG AI…' });

    try {
      // Export current subject (without bg replacement) as PNG blob
      const temp = document.createElement('canvas');
      renderComposite(temp, false);
      const blob = await new Promise<Blob | null>(res => temp.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Could not encode image.');

      const form = new FormData();
      form.append('file', blob, `${fileName}.png`);

      const headers: Record<string, string> = {};
      if (userApiKey.trim()) {
        headers['x-withoutbg-api-key'] = userApiKey.trim();
      }

      const resp = await fetch(`${apiHost}/api/image/remove-bg`, {
        method: 'POST',
        headers,
        body: form,
      });

      if (!resp.ok) {
        let msg = `Background removal failed (HTTP ${resp.status}).`;
        try {
          const data = await resp.json();
          if (data.error) msg = data.error;
          if (data.code === 'MISSING_API_KEY' || data.code === 'CREDITS_EXHAUSTED') {
            setShowKeyInput(true);
          }
        } catch {
          // keep default message
        }
        throw new Error(msg);
      }

      const resultBlob = await resp.blob();
      const url = URL.createObjectURL(resultBlob);
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const next = document.createElement('canvas');
          next.width = img.naturalWidth || base.width;
          next.height = img.naturalHeight || base.height;
          next.getContext('2d')?.drawImage(img, 0, 0);
          baseCanvasRef.current = next;
          setAdj(DEFAULT_ADJ);
          setScan(DEFAULT_SCAN);
          pushHistory(next);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('Failed to decode PNG returned by withoutBG.'));
        };
        img.src = url;
      });

      setStatusMsg({ type: 'success', text: 'Background removed with withoutBG AI!' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Background removal failed.';
      setStatusMsg({ type: 'error', text: message });
    } finally {
      setIsRemovingBg(false);
    }
  };

  // ── Canvas Pointer Coordinates Helper ──
  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = displayCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * canvas.width,
      y: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  // ── Canvas Interaction (Magic Wand + Draw/Annotate) ──
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!baseCanvasRef.current || comparing) return;

    // Offline Magic Wand click-to-erase
    if (activeTab === 'bg' && magicWandActive) {
      bakePendingFilters(false);
      const base = baseCanvasRef.current;
      const ctx = base.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;
      const pt = getCanvasPoint(e);
      const imgData = ctx.getImageData(0, 0, base.width, base.height);
      const count = applyMagicWandErase(
        imgData.data,
        base.width,
        base.height,
        pt.x,
        pt.y,
        wandTolerance,
        wandContiguous
      );
      if (count > 0) {
        ctx.putImageData(imgData, 0, 0);
        pushHistory(base);
        setStatusMsg({ type: 'success', text: `Erased ${count.toLocaleString()} background pixels.` });
      }
      return;
    }

    // Draw / Annotate mode
    if (activeTab !== 'draw') return;
    bakePendingFilters(false);
    const base = baseCanvasRef.current;
    const ctx = base.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const pt = getCanvasPoint(e);

    // Click-to-stamp Text tool
    if (drawTool === 'text') {
      const label = textValue.trim();
      if (!label) return;
      const scaleFactor = Math.max(1, base.width / 800);
      const px = Math.round(textSize * scaleFactor);
      ctx.save();
      ctx.font = `700 ${px}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = drawColor;
      ctx.textBaseline = 'middle';
      ctx.fillText(label, pt.x, pt.y);
      ctx.restore();
      pushHistory(base);
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drawStateRef.current = {
      active: true,
      startX: pt.x,
      startY: pt.y,
      lastX: pt.x,
      lastY: pt.y,
      snapshot: cloneCanvas(base),
    };

    const brushPx = Math.max(2, drawSize * (base.width / 800));
    if (drawTool === 'pen') {
      ctx.save();
      ctx.fillStyle = drawColor;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, brushPx / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      setRenderTick(t => t + 1);
    } else if (drawTool === 'mosaic') {
      const radius = Math.max(12, drawSize * 3 * (base.width / 800));
      applyMosaicRegion(ctx, pt.x, pt.y, radius, Math.max(8, Math.round(base.width / 65)));
      setRenderTick(t => t + 1);
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const ds = drawStateRef.current;
    const base = baseCanvasRef.current;
    if (!ds.active || !base || activeTab !== 'draw') return;
    const ctx = base.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const pt = getCanvasPoint(e);
    const brushPx = Math.max(2, drawSize * (base.width / 800));

    if (drawTool === 'pen') {
      ctx.save();
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = brushPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(ds.lastX, ds.lastY);
      ctx.lineTo(pt.x, pt.y);
      ctx.stroke();
      ctx.restore();
      ds.lastX = pt.x;
      ds.lastY = pt.y;
      setRenderTick(t => t + 1);
    } else if (drawTool === 'mosaic') {
      const radius = Math.max(12, drawSize * 3 * (base.width / 800));
      applyMosaicRegion(ctx, pt.x, pt.y, radius, Math.max(8, Math.round(base.width / 65)));
      ds.lastX = pt.x;
      ds.lastY = pt.y;
      setRenderTick(t => t + 1);
    } else if (ds.snapshot) {
      // Live preview for rect / line / arrow by restoring pre-stroke snapshot
      ctx.clearRect(0, 0, base.width, base.height);
      ctx.drawImage(ds.snapshot, 0, 0);
      ctx.save();
      ctx.strokeStyle = drawColor;
      ctx.fillStyle = drawColor;
      ctx.lineWidth = brushPx;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (drawTool === 'rect') {
        ctx.strokeRect(ds.startX, ds.startY, pt.x - ds.startX, pt.y - ds.startY);
      } else if (drawTool === 'line') {
        ctx.beginPath();
        ctx.moveTo(ds.startX, ds.startY);
        ctx.lineTo(pt.x, pt.y);
        ctx.stroke();
      } else if (drawTool === 'arrow') {
        drawArrow(ctx, ds.startX, ds.startY, pt.x, pt.y, brushPx);
      }
      ctx.restore();
      setRenderTick(t => t + 1);
    }
  };

  const handleCanvasPointerUp = () => {
    const ds = drawStateRef.current;
    if (!ds.active || !baseCanvasRef.current) return;
    ds.active = false;
    ds.snapshot = null;
    pushHistory(baseCanvasRef.current);
  };

  // ── Export (PNG / JPG / WebP / PDF) ──
  const handleExport = async (format: 'png' | 'jpeg' | 'webp' | 'pdf') => {
    if (!baseCanvasRef.current) return;
    const out = document.createElement('canvas');
    renderComposite(out, true);

    if (format === 'jpeg') {
      // Composite white behind transparent regions for JPEG
      const flat = document.createElement('canvas');
      flat.width = out.width;
      flat.height = out.height;
      const fctx = flat.getContext('2d');
      if (fctx) {
        fctx.fillStyle = '#FFFFFF';
        fctx.fillRect(0, 0, flat.width, flat.height);
        fctx.drawImage(out, 0, 0);
      }
      const url = flat.toDataURL('image/jpeg', jpgQuality / 100);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.jpg`;
      a.click();
      return;
    }

    if (format === 'png' || format === 'webp') {
      const mime = format === 'png' ? 'image/png' : 'image/webp';
      const url = out.toDataURL(mime, format === 'webp' ? jpgQuality / 100 : undefined);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.${format}`;
      a.click();
      return;
    }

    // Export directly as PDF via installed pdf-lib
    try {
      const pngBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        out.toBlob(
          b => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('PNG encode failed'))),
          'image/png'
        );
      });
      const pdfDoc = await PDFDocument.create();
      const embedded = await pdfDoc.embedPng(pngBytes);
      const page = pdfDoc.addPage([out.width, out.height]);
      page.drawImage(embedded, { x: 0, y: 0, width: out.width, height: out.height });
      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      setStatusMsg({ type: 'error', text: 'Failed to export as PDF.' });
    }
  };

  const handleSaveApiKey = (val: string) => {
    setUserApiKey(val);
    if (val.trim()) {
      localStorage.setItem(API_KEY_STORAGE, val.trim());
    } else {
      localStorage.removeItem(API_KEY_STORAGE);
    }
  };

  const handleBgImageUpload = (files: FileList | null) => {
    if (!files || !files.length) return;
    const url = URL.createObjectURL(files[0]);
    const img = new Image();
    img.onload = () => {
      setBgImage(img);
      setBgMode('image');
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const canvasCursor =
    activeTab === 'bg' && magicWandActive
      ? 'crosshair'
      : activeTab === 'draw'
        ? drawTool === 'text' ? 'text' : 'crosshair'
        : 'default';

  const interactivePointer = (activeTab === 'bg' && magicWandActive) || activeTab === 'draw';

  // ── Upload Landing State ──
  if (!hasImage) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {statusMsg && (
          <div className={`ie-alert ie-alert-${statusMsg.type}`} role="alert">
            <AlertCircle size={16} />
            <span>{statusMsg.text}</span>
          </div>
        )}
        <div
          className={`upload-area ${isDraggingFile ? 'dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setIsDraggingFile(true); }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={e => { e.preventDefault(); setIsDraggingFile(false); handleFileList(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          aria-label="Upload an image to edit"
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <Wand2 size={48} className="upload-icon" aria-hidden="true" />
          <div>
            <p><strong style={{ color: 'var(--text-main)' }}>Drag & Drop an Image</strong> or click to browse</p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
              Supports PNG, JPG, WebP, BMP — or press <strong>Ctrl+V</strong> to paste from clipboard
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.4rem', marginTop: '1rem' }}>
              {['Scanned Copy B&W', 'Crop', 'Remove BG (withoutBG AI)', 'Magic Wand', 'Draw & Blur', 'Resize & Export PDF'].map(tag => (
                <span
                  key={tag}
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    padding: '0.25rem 0.6rem',
                    borderRadius: 999,
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => handleFileList(e.target.files)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ie-root">
      {/* Top Action Bar */}
      <div className="ie-toolbar">
        <div className="ie-toolbar-group">
          <button className="ie-icon-btn" onClick={() => fileInputRef.current?.click()} title="Open new image">
            <Upload size={15} /> <span>New</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => handleFileList(e.target.files)}
          />
          <button className="ie-icon-btn" onClick={handleUndo} disabled={!historyState.canUndo} title="Undo" aria-label="Undo">
            <Undo2 size={15} />
          </button>
          <button className="ie-icon-btn" onClick={handleRedo} disabled={!historyState.canRedo} title="Redo" aria-label="Redo">
            <Redo2 size={15} />
          </button>
          <button
            className={`ie-icon-btn ${comparing ? 'active' : ''}`}
            onPointerDown={() => setComparing(true)}
            onPointerUp={() => setComparing(false)}
            onPointerLeave={() => setComparing(false)}
            title="Hold to compare original"
          >
            <Eye size={15} /> <span>Compare</span>
          </button>
          <button className="ie-icon-btn" onClick={handleResetAll} title="Reset to original">
            <Trash2 size={15} /> <span>Reset</span>
          </button>
        </div>

        <div className="ie-toolbar-group">
          <span className="ie-dims-badge">{dims.w} × {dims.h} px</span>
          <button className="ie-export-btn primary" onClick={() => handleExport('png')}>
            <Download size={14} /> PNG
          </button>
          <button className="ie-export-btn" onClick={() => handleExport('jpeg')}>
            JPG
          </button>
          <button className="ie-export-btn" onClick={() => handleExport('webp')}>
            WebP
          </button>
          <button className="ie-export-btn" onClick={() => handleExport('pdf')} title="Export as PDF">
            <FileText size={14} /> PDF
          </button>
        </div>
      </div>

      {/* Status Alert */}
      {statusMsg && (
        <div className={`ie-alert ie-alert-${statusMsg.type}`} role="status">
          {statusMsg.type === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span style={{ flex: 1 }}>{statusMsg.text}</span>
          <button
            onClick={() => setStatusMsg(null)}
            style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 2 }}
            aria-label="Dismiss message"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="ie-layout">
        {/* Canvas Stage */}
        <div className="ie-stage" ref={stageRef}>
          <div className="ie-canvas-wrap ie-checkerboard">
            <canvas
              ref={displayCanvasRef}
              className="ie-canvas"
              style={{
                cursor: canvasCursor,
                touchAction: interactivePointer ? 'none' : 'auto',
              }}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={handleCanvasPointerUp}
            />

            {/* Interactive Crop Overlay (Rectangle or 4-Corner Document Flatten) */}
            {activeTab === 'crop' && !comparing && cropMode === 'rect' && (
              <div
                className="ie-crop-layer"
                onPointerMove={onCropPointerMove}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
              >
                <div
                  className="ie-crop-box"
                  style={{
                    left: `${cropRect.x * 100}%`,
                    top: `${cropRect.y * 100}%`,
                    width: `${cropRect.w * 100}%`,
                    height: `${cropRect.h * 100}%`,
                  }}
                  onPointerDown={e => startCropDrag(e, 'move')}
                >
                  <div className="ie-crop-grid" />
                  <span className="ie-crop-handle nw" onPointerDown={e => startCropDrag(e, 'nw')} />
                  <span className="ie-crop-handle ne" onPointerDown={e => startCropDrag(e, 'ne')} />
                  <span className="ie-crop-handle sw" onPointerDown={e => startCropDrag(e, 'sw')} />
                  <span className="ie-crop-handle se" onPointerDown={e => startCropDrag(e, 'se')} />
                </div>
              </div>
            )}

            {activeTab === 'crop' && !comparing && cropMode === 'corners' && (
              <div
                className="ie-quad-layer"
                onPointerMove={onQuadPointerMove}
                onPointerUp={endQuadCornerDrag}
                onPointerCancel={endQuadCornerDrag}
              >
                <svg className="ie-quad-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                  <polygon
                    points={quadCorners.map(p => `${(p.x * 100).toFixed(2)},${(p.y * 100).toFixed(2)}`).join(' ')}
                    fill="rgba(59, 130, 246, 0.16)"
                    stroke="#3B82F6"
                    strokeWidth="0.7"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
                {quadCorners.map((pt, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="ie-quad-handle"
                    style={{ left: `${pt.x * 100}%`, top: `${pt.y * 100}%` }}
                    onPointerDown={e => startQuadCornerDrag(e, idx)}
                    aria-label={`Drag document corner ${idx + 1}`}
                  >
                    <span>{idx + 1}</span>
                  </button>
                ))}
              </div>
            )}

            {comparing && <span className="ie-compare-pill">Original</span>}
          </div>
        </div>

        {/* Tool Sidebar */}
        <aside className="ie-sidebar">
          {/* Tool Tabs */}
          <div className="ie-tab-bar" role="tablist">
            {[
              { id: 'adjust', label: 'Adjust', icon: <SlidersHorizontal size={15} /> },
              { id: 'scan',   label: 'Scan B&W', icon: <ScanLine size={15} /> },
              { id: 'crop',   label: 'Crop', icon: <Crop size={15} /> },
              { id: 'bg',     label: 'Remove BG', icon: <Eraser size={15} /> },
              { id: 'draw',   label: 'Draw', icon: <Pencil size={15} /> },
              { id: 'resize', label: 'Resize', icon: <Maximize2 size={15} /> },
            ].map(tab => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                className={`ie-tab ${activeTab === tab.id ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab(tab.id as EditorTab);
                  if (tab.id !== 'bg') setMagicWandActive(false);
                }}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Tab Panel Content */}
          <div className="ie-panel">
            {/* ── 1. ADJUST ── */}
            {activeTab === 'adjust' && (
              <>
                <div className="ie-section">
                  <label className="ie-label">Rotate & Flip</label>
                  <div className="ie-btn-grid-4">
                    <button className="ie-chip-btn" onClick={() => applyTransform('rot-l')} title="Rotate Left 90°">
                      <RotateCcw size={15} /> -90°
                    </button>
                    <button className="ie-chip-btn" onClick={() => applyTransform('rot-r')} title="Rotate Right 90°">
                      <RotateCw size={15} /> +90°
                    </button>
                    <button className="ie-chip-btn" onClick={() => applyTransform('flip-h')} title="Flip Horizontal">
                      <FlipHorizontal2 size={15} /> Flip H
                    </button>
                    <button className="ie-chip-btn" onClick={() => applyTransform('flip-v')} title="Flip Vertical">
                      <FlipVertical2 size={15} /> Flip V
                    </button>
                  </div>
                </div>

                {[
                  { key: 'straighten', label: 'Straighten', min: -45, max: 45, unit: '°' },
                  { key: 'brightness', label: 'Brightness', min: 20, max: 200, unit: '%' },
                  { key: 'contrast',   label: 'Contrast',   min: 20, max: 200, unit: '%' },
                  { key: 'saturation', label: 'Saturation', min: 0,  max: 200, unit: '%' },
                  { key: 'sharpness',  label: 'Sharpness',  min: 0,  max: 100, unit: '%' },
                ].map(s => (
                  <div className="ie-slider-row" key={s.key}>
                    <div className="ie-slider-head">
                      <span>{s.label}</span>
                      <span>{adj[s.key as keyof Adjustments]}{s.unit}</span>
                    </div>
                    <input
                      type="range"
                      className="range-input"
                      min={s.min}
                      max={s.max}
                      value={adj[s.key as keyof Adjustments]}
                      onChange={e => setAdj(prev => ({ ...prev, [s.key]: Number(e.target.value) }))}
                    />
                  </div>
                ))}

                <div className="ie-slider-row">
                  <div className="ie-slider-head">
                    <span>JPG / WebP Export Quality</span>
                    <span>{jpgQuality}%</span>
                  </div>
                  <input
                    type="range"
                    className="range-input"
                    min={40}
                    max={100}
                    value={jpgQuality}
                    onChange={e => setJpgQuality(Number(e.target.value))}
                  />
                </div>

                <button className="ie-secondary-btn" onClick={() => setAdj(DEFAULT_ADJ)}>
                  Reset Adjustments
                </button>
              </>
            )}

            {/* ── 2. SCANNED COPY B&W ── */}
            {activeTab === 'scan' && (
              <>
                <div className="ie-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
                  <span className="ie-label" style={{ margin: 0 }}>Document Edge Detection</span>
                  <button
                    className="ie-chip-btn active"
                    style={{ width: '100%', padding: '0.6rem' }}
                    onClick={handleAutoDetectCorners}
                  >
                    <ScanLine size={14} /> Auto-Detect Corners & Flatten
                  </button>
                  <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                    Finds page corners automatically so you can unwarp tilted photos before applying B&amp;W scan.
                  </span>
                </div>

                <div className="ie-section">
                  <label className="ie-label">Scanned Copy Preset</label>
                  <div className="ie-btn-grid-2">
                    {[
                      { id: 'none',       label: 'Original',    desc: 'No scan filter' },
                      { id: 'clean-scan', label: 'Clean Scan',  desc: 'Removes shadows → white paper' },
                      { id: 'crisp-bw',   label: 'Crisp B&W',   desc: 'High-contrast pure black & white' },
                      { id: 'photocopy',  label: 'Photocopy',   desc: 'Classic B&W copier grain' },
                    ].map(preset => (
                      <button
                        key={preset.id}
                        className={`ie-preset-card ${scan.mode === preset.id ? 'active' : ''}`}
                        onClick={() => setScan(prev => ({
                          ...prev,
                          mode: preset.id as ScanMode,
                          threshold: preset.id === 'clean-scan' ? 145 : preset.id === 'crisp-bw' ? 135 : 128,
                          contrast: preset.id === 'photocopy' ? 1.5 : 1.8,
                        }))}
                      >
                        <strong>{preset.label}</strong>
                        <span>{preset.desc}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {scan.mode !== 'none' && (
                  <>
                    <div className="ie-slider-row">
                      <div className="ie-slider-head">
                        <span>Ink Threshold</span>
                        <span>{scan.threshold}</span>
                      </div>
                      <input
                        type="range"
                        className="range-input"
                        min={40}
                        max={220}
                        value={scan.threshold}
                        onChange={e => setScan(prev => ({ ...prev, threshold: Number(e.target.value) }))}
                      />
                    </div>

                    <div className="ie-slider-row">
                      <div className="ie-slider-head">
                        <span>Scan Contrast</span>
                        <span>{scan.contrast.toFixed(1)}×</span>
                      </div>
                      <input
                        type="range"
                        className="range-input"
                        min={5}
                        max={30}
                        value={Math.round(scan.contrast * 10)}
                        onChange={e => setScan(prev => ({ ...prev, contrast: Number(e.target.value) / 10 }))}
                      />
                    </div>

                    {scan.mode === 'photocopy' && (
                      <div className="ie-slider-row">
                        <div className="ie-slider-head">
                          <span>Paper Grain</span>
                          <span>{scan.grain}%</span>
                        </div>
                        <input
                          type="range"
                          className="range-input"
                          min={0}
                          max={80}
                          value={scan.grain}
                          onChange={e => setScan(prev => ({ ...prev, grain: Number(e.target.value) }))}
                        />
                      </div>
                    )}

                    <button
                      className="download-btn"
                      style={{ padding: '0.65rem 1rem', fontSize: '0.85rem' }}
                      onClick={() => {
                        bakePendingFilters(false);
                        if (baseCanvasRef.current) pushHistory(baseCanvasRef.current);
                        setStatusMsg({ type: 'success', text: 'Scan effect baked into image.' });
                      }}
                    >
                      <Check size={16} /> Bake Scan Effect
                    </button>
                  </>
                )}
              </>
            )}

            {/* ── 3. CROP ── */}
            {activeTab === 'crop' && (
              <>
                <div className="ie-section">
                  <label className="ie-label">Crop Mode</label>
                  <div className="ie-btn-grid-2">
                    <button
                      className={`ie-chip-btn ${cropMode === 'rect' ? 'active' : ''}`}
                      onClick={() => setCropMode('rect')}
                    >
                      <Crop size={14} /> Rectangle
                    </button>
                    <button
                      className={`ie-chip-btn ${cropMode === 'corners' ? 'active' : ''}`}
                      onClick={() => setCropMode('corners')}
                    >
                      <ScanLine size={14} /> 4-Corner Scan
                    </button>
                  </div>
                </div>

                {cropMode === 'rect' ? (
                  <>
                    <div className="ie-section">
                      <label className="ie-label">Aspect Ratio</label>
                      <div className="ie-btn-grid-3">
                        {(Object.keys(ASPECT_RATIOS) as AspectPreset[]).map(k => (
                          <button
                            key={k}
                            className={`ie-chip-btn ${aspectPreset === k ? 'active' : ''}`}
                            onClick={() => selectAspectPreset(k)}
                          >
                            {ASPECT_RATIOS[k].label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="ie-info-box">
                      Crop Selection:{' '}
                      <strong>
                        {Math.round(cropRect.w * dims.w)} × {Math.round(cropRect.h * dims.h)} px
                      </strong>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Drag the box or corner handles on the canvas to adjust.
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="download-btn"
                        style={{ flex: 1, padding: '0.7rem', fontSize: '0.875rem' }}
                        onClick={applyCrop}
                      >
                        <Check size={16} /> Apply Crop
                      </button>
                      <button
                        className="ie-secondary-btn"
                        onClick={() => {
                          setAspectPreset('free');
                          setCropRect({ x: 0.1, y: 0.1, w: 0.8, h: 0.8 });
                        }}
                      >
                        Reset
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <button
                      className="ie-chip-btn active"
                      style={{ width: '100%', padding: '0.65rem' }}
                      onClick={handleAutoDetectCorners}
                    >
                      <Sparkles size={14} /> Auto-Detect Document Corners
                    </button>

                    <div className="ie-info-box">
                      <strong>4-Point Perspective Flatten</strong>
                      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Drag corners <strong>1–4</strong> onto the document edges to automatically deskew and flatten tilted photos into a straight page.
                      </p>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="download-btn"
                        style={{ flex: 1, padding: '0.7rem', fontSize: '0.875rem' }}
                        onClick={applyPerspectiveCrop}
                      >
                        <Check size={16} /> Flatten &amp; Crop
                      </button>
                      <button
                        className="ie-secondary-btn"
                        onClick={() => setQuadCorners(DEFAULT_QUAD.map(p => ({ ...p })) as QuadCorners)}
                      >
                        Reset
                      </button>
                    </div>
                  </>
                )}
              </>
            )}

            {/* ── 4. REMOVE BG & BACKGROUND REPLACEMENT ── */}
            {activeTab === 'bg' && (
              <>
                {/* AI withoutBG Section */}
                <div className="ie-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span className="ie-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <Sparkles size={14} color="var(--primary)" /> withoutBG AI
                    </span>
                    <span style={{
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: userApiKey.trim() || serverHasKey ? 'var(--success)' : 'var(--warning)'
                    }}>
                      {userApiKey.trim()
                        ? '● Using Your Key'
                        : serverHasKey
                          ? '● Server Key Ready'
                          : '● Key Required'}
                    </span>
                  </div>

                  <button
                    className="download-btn"
                    style={{ width: '100%', padding: '0.75rem', fontSize: '0.875rem' }}
                    onClick={handleAiRemoveBg}
                    disabled={isRemovingBg}
                  >
                    {isRemovingBg ? <Loader2 className="spinner" size={16} /> : <Sparkles size={16} />}
                    {isRemovingBg ? 'Removing Background…' : 'Remove Background (AI)'}
                  </button>

                  <button
                    className="ie-link-btn"
                    onClick={() => setShowKeyInput(v => !v)}
                    style={{ marginTop: '0.5rem' }}
                  >
                    <KeyRound size={12} /> {showKeyInput ? 'Hide Custom API Key' : 'Use Own withoutBG API Key'}
                  </button>

                  {showKeyInput && (
                    <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                      <input
                        type="password"
                        value={userApiKey}
                        onChange={e => handleSaveApiKey(e.target.value)}
                        placeholder="sk_... (saved locally in your browser)"
                        className="ie-input"
                        aria-label="Custom withoutBG API Key"
                      />
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                        Overrides the server key when set. Get free credits at withoutbg.com.
                      </span>
                    </div>
                  )}
                </div>

                {/* Offline Magic Wand Section */}
                <div className="ie-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <span className="ie-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                      <Wand2 size={14} /> Offline Magic Wand
                    </span>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Free / Local</span>
                  </div>

                  <button
                    className={`ie-chip-btn ${magicWandActive ? 'active' : ''}`}
                    style={{ width: '100%', padding: '0.6rem' }}
                    onClick={() => setMagicWandActive(v => !v)}
                  >
                    <Wand2 size={14} />
                    {magicWandActive ? 'Tap Image Background to Erase (Active)' : 'Enable Click-to-Erase Wand'}
                  </button>

                  <div className="ie-slider-row" style={{ marginTop: '0.65rem' }}>
                    <div className="ie-slider-head">
                      <span>Color Tolerance</span>
                      <span>{wandTolerance}%</span>
                    </div>
                    <input
                      type="range"
                      className="range-input"
                      min={2}
                      max={75}
                      value={wandTolerance}
                      onChange={e => setWandTolerance(Number(e.target.value))}
                    />
                  </div>

                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', cursor: 'pointer', marginTop: '0.4rem' }}>
                    <input
                      type="checkbox"
                      checked={wandContiguous}
                      onChange={e => setWandContiguous(e.target.checked)}
                    />
                    Contiguous only (uncheck to clear inside letters)
                  </label>
                </div>

                {/* Background Replacement */}
                <div className="ie-section">
                  <label className="ie-label">Background Replacement</label>
                  <div className="ie-btn-grid-3">
                    <button
                      className={`ie-chip-btn ${bgMode === 'transparent' ? 'active' : ''}`}
                      onClick={() => setBgMode('transparent')}
                    >
                      Transparent
                    </button>
                    <button
                      className={`ie-chip-btn ${bgMode === 'solid' ? 'active' : ''}`}
                      onClick={() => setBgMode('solid')}
                    >
                      Solid Color
                    </button>
                    <button
                      className={`ie-chip-btn ${bgMode === 'image' ? 'active' : ''}`}
                      onClick={() => bgImgInputRef.current?.click()}
                    >
                      <ImageIcon size={13} /> Image
                    </button>
                    <input
                      ref={bgImgInputRef}
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      onChange={e => handleBgImageUpload(e.target.files)}
                    />
                  </div>

                  {bgMode === 'solid' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginTop: '0.6rem' }}>
                      {SOLID_BG_SWATCHES.map(sw => (
                        <button
                          key={sw.color}
                          title={sw.label}
                          onClick={() => setBgColor(sw.color)}
                          style={{
                            width: 28,
                            height: 28,
                            borderRadius: 6,
                            background: sw.color,
                            border: bgColor === sw.color ? '2px solid var(--primary)' : '1px solid var(--border)',
                            cursor: 'pointer',
                          }}
                          aria-label={`Set background color to ${sw.label}`}
                        />
                      ))}
                      <input
                        type="color"
                        value={bgColor}
                        onChange={e => setBgColor(e.target.value)}
                        style={{ width: 32, height: 28, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                        aria-label="Custom background color"
                      />
                    </div>
                  )}
                </div>
              </>
            )}

            {/* ── 5. DRAW & ANNOTATE ── */}
            {activeTab === 'draw' && (
              <>
                <div className="ie-section">
                  <label className="ie-label">Annotation Tool</label>
                  <div className="ie-btn-grid-3">
                    {[
                      { id: 'pen',    label: 'Pen',    icon: <Pencil size={14} /> },
                      { id: 'mosaic', label: 'Blur',   icon: <Grid3x3 size={14} /> },
                      { id: 'text',   label: 'Text',   icon: <Type size={14} /> },
                      { id: 'rect',   label: 'Box',    icon: <Square size={14} /> },
                      { id: 'line',   label: 'Line',   icon: <Minus size={14} /> },
                      { id: 'arrow',  label: 'Arrow',  icon: <MoveUpRight size={14} /> },
                    ].map(t => (
                      <button
                        key={t.id}
                        className={`ie-chip-btn ${drawTool === t.id ? 'active' : ''}`}
                        onClick={() => setDrawTool(t.id as DrawTool)}
                      >
                        {t.icon} {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {drawTool === 'text' ? (
                  <>
                    <div className="ie-section">
                      <label className="ie-label">Text to Stamp (tap canvas to place)</label>
                      <input
                        type="text"
                        className="ie-input"
                        value={textValue}
                        onChange={e => setTextValue(e.target.value)}
                        placeholder="Enter text…"
                      />
                    </div>
                    <div className="ie-slider-row">
                      <div className="ie-slider-head">
                        <span>Font Size</span>
                        <span>{textSize}px</span>
                      </div>
                      <input
                        type="range"
                        className="range-input"
                        min={14}
                        max={120}
                        value={textSize}
                        onChange={e => setTextSize(Number(e.target.value))}
                      />
                    </div>
                  </>
                ) : (
                  <div className="ie-slider-row">
                    <div className="ie-slider-head">
                      <span>{drawTool === 'mosaic' ? 'Blur Brush Radius' : 'Stroke Thickness'}</span>
                      <span>{drawSize}px</span>
                    </div>
                    <input
                      type="range"
                      className="range-input"
                      min={2}
                      max={32}
                      value={drawSize}
                      onChange={e => setDrawSize(Number(e.target.value))}
                    />
                  </div>
                )}

                {drawTool !== 'mosaic' && (
                  <div className="ie-section">
                    <label className="ie-label">Color</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                      {['#EF4444', '#2563EB', '#10B981', '#F59E0B', '#000000', '#FFFFFF'].map(c => (
                        <button
                          key={c}
                          onClick={() => setDrawColor(c)}
                          style={{
                            width: 26,
                            height: 26,
                            borderRadius: 6,
                            background: c,
                            border: drawColor === c ? '2px solid var(--primary)' : '1px solid var(--border)',
                            cursor: 'pointer',
                          }}
                          aria-label={`Select color ${c}`}
                        />
                      ))}
                      <input
                        type="color"
                        value={drawColor}
                        onChange={e => setDrawColor(e.target.value)}
                        style={{ width: 32, height: 26, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                        aria-label="Custom stroke color"
                      />
                    </div>
                  </div>
                )}

                <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', margin: 0 }}>
                  {drawTool === 'text'
                    ? 'Tap anywhere on the image to stamp your text. Use Undo to step back.'
                    : drawTool === 'mosaic'
                      ? 'Brush over sensitive info to pixelate it permanently.'
                      : 'Draw directly on the canvas. Each stroke saves to Undo history.'}
                </p>
              </>
            )}

            {/* ── 6. RESIZE ── */}
            {activeTab === 'resize' && (
              <>
                <div className="ie-section">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
                    <label className="ie-label" style={{ margin: 0 }}>Dimensions (px)</label>
                    <button
                      className="ie-link-btn"
                      onClick={() => setLockAspect(v => !v)}
                    >
                      {lockAspect ? <Lock size={12} /> : <Unlock size={12} />}
                      {lockAspect ? 'Aspect Locked' : 'Unlocked'}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                    <div>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Width</span>
                      <input
                        type="number"
                        className="ie-input"
                        min={1}
                        max={8000}
                        value={resizeW}
                        onChange={e => handleResizeWidthChange(Number(e.target.value))}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Height</span>
                      <input
                        type="number"
                        className="ie-input"
                        min={1}
                        max={8000}
                        value={resizeH}
                        onChange={e => handleResizeHeightChange(Number(e.target.value))}
                      />
                    </div>
                  </div>
                </div>

                <div className="ie-section">
                  <label className="ie-label">Quick Scale</label>
                  <div className="ie-btn-grid-4">
                    {[
                      { label: '50%',   fn: () => handleResizeWidthChange(Math.round(dims.w * 0.5)) },
                      { label: '75%',   fn: () => handleResizeWidthChange(Math.round(dims.w * 0.75)) },
                      { label: '1080w', fn: () => handleResizeWidthChange(1080) },
                      { label: 'A4',    fn: () => { setLockAspect(false); setResizeW(1240); setResizeH(1754); } },
                    ].map(q => (
                      <button key={q.label} className="ie-chip-btn" onClick={q.fn}>
                        {q.label}
                      </button>
                    ))}
                  </div>
                </div>

                <button
                  className="download-btn"
                  style={{ width: '100%', padding: '0.7rem', fontSize: '0.875rem' }}
                  onClick={applyResize}
                >
                  <Check size={16} /> Apply Resize
                </button>
              </>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
