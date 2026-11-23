import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, Download, Trash2, ArrowUp, ArrowDown, LayoutGrid, FileText
} from 'lucide-react';
import { PDFDocument } from 'pdf-lib';

type CollageLayout = 'vertical' | 'horizontal' | 'grid-2' | 'grid-3' | 'auto';

interface CollageImage {
  id: string;
  name: string;
  url: string;
  img: HTMLImageElement;
}

const LAYOUT_OPTIONS: { id: CollageLayout; label: string }[] = [
  { id: 'vertical',   label: 'Stacked (Front+Back)' },
  { id: 'horizontal', label: 'Side-by-Side' },
  { id: 'grid-2',     label: '2×2 Grid' },
  { id: 'grid-3',     label: '3×3 Grid' },
  { id: 'auto',       label: 'Auto Grid' },
];

function drawRoundedImage(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  cover: boolean
) {
  ctx.save();
  if (radius > 0) {
    const r = Math.min(radius, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.clip();
  }
  if (cover) {
    const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * scale;
    const dh = img.naturalHeight * scale;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } else {
    ctx.drawImage(img, x, y, w, h);
  }
  ctx.restore();
}

export default function ImageCollageTool() {
  const [images, setImages]         = useState<CollageImage[]>([]);
  const [layout, setLayout]         = useState<CollageLayout>('vertical');
  const [gap, setGap]               = useState(20);
  const [padding, setPadding]       = useState(24);
  const [radius, setRadius]         = useState(8);
  const [bgColor, setBgColor]       = useState('#FFFFFF');
  const [targetWidth, setTargetWidth] = useState(1600);
  const [isDragging, setIsDragging] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .forEach(file => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          setImages(prev => [
            ...prev,
            { id: Math.random().toString(36).substring(2, 11), name: file.name, url, img },
          ]);
        };
        img.src = url;
      });
  };

  const removeImg = (id: string) => {
    setImages(prev => {
      const found = prev.find(i => i.id === id);
      if (found) URL.revokeObjectURL(found.url);
      return prev.filter(i => i.id !== id);
    });
  };

  const moveImg = (idx: number, dir: -1 | 1) => {
    setImages(prev => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  };

  const renderCollage = useCallback((canvas: HTMLCanvasElement) => {
    if (!images.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (layout === 'vertical') {
      const innerW = Math.max(200, targetWidth - padding * 2);
      const scaledHeights = images.map(it => Math.round((it.img.naturalHeight / it.img.naturalWidth) * innerW));
      const totalH = padding * 2 + scaledHeights.reduce((a, b) => a + b, 0) + gap * Math.max(0, images.length - 1);
      canvas.width = targetWidth;
      canvas.height = totalH;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let y = padding;
      images.forEach((it, i) => {
        drawRoundedImage(ctx, it.img, padding, y, innerW, scaledHeights[i], radius, false);
        y += scaledHeights[i] + gap;
      });
      return;
    }

    if (layout === 'horizontal') {
      const cellH = Math.round(targetWidth * 0.55);
      const scaledWidths = images.map(it => Math.round((it.img.naturalWidth / it.img.naturalHeight) * cellH));
      const totalW = padding * 2 + scaledWidths.reduce((a, b) => a + b, 0) + gap * Math.max(0, images.length - 1);
      canvas.width = totalW;
      canvas.height = cellH + padding * 2;
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      let x = padding;
      images.forEach((it, i) => {
        drawRoundedImage(ctx, it.img, x, padding, scaledWidths[i], cellH, radius, false);
        x += scaledWidths[i] + gap;
      });
      return;
    }

    // Grid layouts (2x2, 3x3, auto)
    const cols =
      layout === 'grid-2' ? 2 :
      layout === 'grid-3' ? 3 :
      Math.ceil(Math.sqrt(images.length));
    const rows = Math.ceil(images.length / cols);
    const cellW = Math.max(100, Math.floor((targetWidth - padding * 2 - gap * (cols - 1)) / cols));
    const cellH = cellW; // clean square tiles with cover-fit
    canvas.width = padding * 2 + cols * cellW + (cols - 1) * gap;
    canvas.height = padding * 2 + rows * cellH + (rows - 1) * gap;
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    images.forEach((it, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const x = padding + c * (cellW + gap);
      const y = padding + r * (cellH + gap);
      drawRoundedImage(ctx, it.img, x, y, cellW, cellH, radius, true);
    });
  }, [images, layout, gap, padding, radius, bgColor, targetWidth]);

  useEffect(() => {
    if (canvasRef.current && images.length > 0) {
      renderCollage(canvasRef.current);
    }
  }, [images, renderCollage]);

  const exportImage = (fmt: 'image/png' | 'image/jpeg') => {
    if (!canvasRef.current || !images.length) return;
    const ext = fmt === 'image/png' ? 'png' : 'jpg';
    const url = canvasRef.current.toDataURL(fmt, 0.94);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collage_${layout}.${ext}`;
    a.click();
  };

  const exportPdf = async () => {
    if (!canvasRef.current || !images.length) return;
    const c = canvasRef.current;
    const jpgBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      c.toBlob(
        b => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('Encode failed'))),
        'image/jpeg',
        0.94
      );
    });
    const pdfDoc = await PDFDocument.create();
    const img = await pdfDoc.embedJpg(jpgBytes);
    const page = pdfDoc.addPage([c.width, c.height]);
    page.drawImage(img, { x: 0, y: 0, width: c.width, height: c.height });
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `collage_${layout}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="ie-layout">
      {/* Live Collage Preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {images.length === 0 ? (
          <div
            className={`upload-area ${isDragging ? 'dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            <LayoutGrid size={48} className="upload-icon" aria-hidden="true" />
            <div>
              <p><strong style={{ color: 'var(--text-main)' }}>Upload 2 or more images</strong> to stitch or make a collage</p>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Great for Front + Back of IDs, receipts, or photo grids
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="ie-toolbar">
              <div className="ie-toolbar-group">
                <button className="ie-icon-btn" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} /> Add Images
                </button>
                <button className="ie-icon-btn" onClick={() => { images.forEach(i => URL.revokeObjectURL(i.url)); setImages([]); }}>
                  <Trash2 size={14} /> Clear
                </button>
              </div>
              <div className="ie-toolbar-group">
                <button className="ie-export-btn primary" onClick={() => exportImage('image/png')}>
                  <Download size={14} /> PNG
                </button>
                <button className="ie-export-btn" onClick={() => exportImage('image/jpeg')}>JPG</button>
                <button className="ie-export-btn" onClick={exportPdf}><FileText size={14} /> PDF</button>
              </div>
            </div>
            <div className="ie-stage">
              <div className="ie-canvas-wrap">
                <canvas ref={canvasRef} className="ie-canvas" />
              </div>
            </div>
          </>
        )}
        <input ref={fileInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
      </div>

      {/* Sidebar Controls */}
      <aside className="ie-sidebar">
        <div className="ie-panel">
          <div className="ie-section">
            <label className="ie-label">Layout</label>
            <div className="ie-btn-grid-2">
              {LAYOUT_OPTIONS.map(opt => (
                <button
                  key={opt.id}
                  className={`ie-chip-btn ${layout === opt.id ? 'active' : ''}`}
                  onClick={() => setLayout(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ie-slider-row">
            <div className="ie-slider-head"><span>Gap Between Images</span><span>{gap}px</span></div>
            <input type="range" className="range-input" min={0} max={80} value={gap} onChange={e => setGap(Number(e.target.value))} />
          </div>

          <div className="ie-slider-row">
            <div className="ie-slider-head"><span>Outer Padding</span><span>{padding}px</span></div>
            <input type="range" className="range-input" min={0} max={80} value={padding} onChange={e => setPadding(Number(e.target.value))} />
          </div>

          <div className="ie-slider-row">
            <div className="ie-slider-head"><span>Corner Radius</span><span>{radius}px</span></div>
            <input type="range" className="range-input" min={0} max={60} value={radius} onChange={e => setRadius(Number(e.target.value))} />
          </div>

          <div className="ie-section">
            <label className="ie-label">Output Width</label>
            <div className="ie-btn-grid-3">
              {[1200, 1600, 2400].map(w => (
                <button key={w} className={`ie-chip-btn ${targetWidth === w ? 'active' : ''}`} onClick={() => setTargetWidth(w)}>
                  {w}px
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span className="ie-label" style={{ margin: 0 }}>Background Color</span>
            <input
              type="color"
              value={bgColor}
              onChange={e => setBgColor(e.target.value)}
              style={{ width: 36, height: 30, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
              aria-label="Collage background color"
            />
          </div>

          {images.length > 0 && (
            <div className="ie-section">
              <label className="ie-label">Order ({images.length} images)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: 220, overflowY: 'auto' }}>
                {images.map((it, idx) => (
                  <div key={it.id} className="file-item" style={{ padding: '0.45rem 0.6rem' }}>
                    <img src={it.url} alt="" style={{ width: 32, height: 32, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                      {it.name}
                    </span>
                    <div className="action-btns">
                      <button className="btn-icon" onClick={() => moveImg(idx, -1)} disabled={idx === 0} aria-label="Move up"><ArrowUp size={13} /></button>
                      <button className="btn-icon" onClick={() => moveImg(idx, 1)} disabled={idx === images.length - 1} aria-label="Move down"><ArrowDown size={13} /></button>
                      <button className="btn-icon" onClick={() => removeImg(it.id)} aria-label="Remove"><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
