import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, Download, Sparkles, Wand2, Loader2, FileText, KeyRound,
  ZoomIn, RotateCcw, Grid, UserSquare2, AlertCircle, CheckCircle2, Trash2
} from 'lucide-react';
import { PDFDocument } from 'pdf-lib';
import { applyMagicWandErase } from '../utils/imageEditorOps';
import { ID_PRESETS, SHEET_PRESETS, computeIdSheetLayout } from '../utils/imageToolsUtils';

const API_KEY_STORAGE = 'pdfmaster_withoutbg_api_key';

const BACKDROP_SWATCHES = [
  { label: 'White',      color: '#FFFFFF' },
  { label: 'ID Blue',    color: '#2563EB' },
  { label: 'Royal Blue', color: '#1D4ED8' },
  { label: 'Red',        color: '#DC2626' },
  { label: 'Light Gray', color: '#E2E8F0' },
];

export default function IdPhotoMakerTool() {
  const apiHost = import.meta.env.VITE_API_URL || 'https://pdfmaster-backend-thhj.onrender.com';

  const [hasImage, setHasImage]         = useState(false);
  const [fileName, setFileName]         = useState('id-photo');
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [statusMsg, setStatusMsg]       = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null);

  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [renderTick, setRenderTick] = useState(0);

  // ID settings
  const [presetId, setPresetId]       = useState('2x2');
  const [sheetId, setSheetId]         = useState('4r');
  const [viewMode, setViewMode]       = useState<'single' | 'sheet'>('single');
  const [bgColor, setBgColor]         = useState('#FFFFFF');
  const [zoom, setZoom]               = useState(1);
  const [offset, setOffset]           = useState({ x: 0, y: 0 });
  const [showGuide, setShowGuide]     = useState(true);
  const [showCutMarks, setShowCutMarks] = useState(true);

  // BG Removal controls
  const [isRemovingBg, setIsRemovingBg] = useState(false);
  const [userApiKey, setUserApiKey]     = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || '');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [wandActive, setWandActive]     = useState(false);
  const [wandTolerance, setWandTolerance] = useState(26);

  const panDragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  const preset = ID_PRESETS.find(p => p.id === presetId) || ID_PRESETS[0];
  const sheetLayout = computeIdSheetLayout(presetId, sheetId, 3, 5);

  const loadFile = (files: FileList | null) => {
    if (!files || !files.length) return;
    const f = files[0];
    if (!f.type.startsWith('image/')) {
      setStatusMsg({ type: 'error', text: 'Please upload a valid image (JPG, PNG, WebP).' });
      return;
    }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);
      sourceCanvasRef.current = c;
      setFileName(f.name.replace(/\.[^.]+$/, '') || 'id-photo');
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      setStatusMsg(null);
      setHasImage(true);
      setRenderTick(t => t + 1);
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setStatusMsg({ type: 'error', text: 'Could not read image file.' });
    };
    img.src = url;
  };

  // Render exact 300-DPI single ID photo canvas
  const renderSingleIdCanvas = useCallback((): HTMLCanvasElement | null => {
    const src = sourceCanvasRef.current;
    if (!src) return null;
    const out = document.createElement('canvas');
    out.width = preset.widthPx;
    out.height = preset.heightPx;
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, out.width, out.height);

    // Cover-fit source into ID frame, then apply zoom & normalized pan offset
    const coverScale = Math.max(out.width / src.width, out.height / src.height) * zoom;
    const dw = src.width * coverScale;
    const dh = src.height * coverScale;
    const dx = (out.width - dw) / 2 + offset.x * out.width;
    const dy = (out.height - dh) / 2 + offset.y * out.height;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, dx, dy, dw, dh);
    return out;
  }, [preset.widthPx, preset.heightPx, bgColor, zoom, offset]);

  // Render exact 300-DPI printable multi-copy sheet canvas
  const renderSheetCanvas = useCallback((): HTMLCanvasElement | null => {
    const single = renderSingleIdCanvas();
    if (!single) return null;
    const { sheet, cells } = sheetLayout;
    const out = document.createElement('canvas');
    out.width = sheet.widthPx;
    out.height = sheet.heightPx;
    const ctx = out.getContext('2d');
    if (!ctx) return null;

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, out.width, out.height);

    for (const cell of cells) {
      ctx.drawImage(single, cell.x, cell.y, cell.w, cell.h);
      if (showCutMarks) {
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 116, 139, 0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(cell.x, cell.y, cell.w, cell.h);
        ctx.restore();
      }
    }
    return out;
  }, [renderSingleIdCanvas, sheetLayout, showCutMarks]);

  // Paint live preview canvas
  useEffect(() => {
    if (!hasImage || !previewCanvasRef.current) return;
    const target = previewCanvasRef.current;
    const rendered = viewMode === 'single' ? renderSingleIdCanvas() : renderSheetCanvas();
    if (!rendered) return;

    target.width = rendered.width;
    target.height = rendered.height;
    const ctx = target.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(rendered, 0, 0);

    // Subtle alignment guide on single preview (never baked into exports!)
    if (viewMode === 'single' && showGuide) {
      const w = target.width;
      const h = target.height;
      ctx.save();
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
      ctx.lineWidth = Math.max(2, Math.round(w / 180));
      ctx.setLineDash([8, 6]);
      // Head oval guide
      ctx.beginPath();
      ctx.ellipse(w * 0.5, h * 0.42, w * 0.24, h * 0.29, 0, 0, Math.PI * 2);
      ctx.stroke();
      // Eye line guide
      ctx.beginPath();
      ctx.moveTo(w * 0.15, h * 0.41);
      ctx.lineTo(w * 0.85, h * 0.41);
      ctx.stroke();
      ctx.restore();
    }
  }, [hasImage, viewMode, showGuide, renderSingleIdCanvas, renderSheetCanvas, renderTick]);

  // AI Background Removal via withoutBG proxy
  const handleAiRemoveBg = async () => {
    const src = sourceCanvasRef.current;
    if (!src) return;
    setIsRemovingBg(true);
    setStatusMsg({ type: 'info', text: 'Removing background via withoutBG AI…' });
    try {
      const blob = await new Promise<Blob | null>(res => src.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Failed to encode image.');

      const form = new FormData();
      form.append('file', blob, `${fileName}.png`);
      const headers: Record<string, string> = {};
      if (userApiKey.trim()) headers['x-withoutbg-api-key'] = userApiKey.trim();

      const resp = await fetch(`${apiHost}/api/image/remove-bg`, { method: 'POST', headers, body: form });
      if (!resp.ok) {
        let msg = `Background removal failed (HTTP ${resp.status}).`;
        try {
          const data = await resp.json();
          if (data.error) msg = data.error;
          if (data.code === 'MISSING_API_KEY' || data.code === 'CREDITS_EXHAUSTED') setShowKeyInput(true);
        } catch { /* ignore */ }
        throw new Error(msg);
      }

      const outBlob = await resp.blob();
      const url = URL.createObjectURL(outBlob);
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const next = document.createElement('canvas');
          next.width = img.naturalWidth || src.width;
          next.height = img.naturalHeight || src.height;
          next.getContext('2d')?.drawImage(img, 0, 0);
          sourceCanvasRef.current = next;
          setRenderTick(t => t + 1);
          URL.revokeObjectURL(url);
          resolve();
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not decode PNG response.')); };
        img.src = url;
      });
      setStatusMsg({ type: 'success', text: 'Background removed! Pick any ID backdrop color below.' });
    } catch (err: unknown) {
      setStatusMsg({ type: 'error', text: err instanceof Error ? err.message : 'Background removal failed.' });
    } finally {
      setIsRemovingBg(false);
    }
  };

  // Pointer interaction: Magic Wand click-to-erase OR Drag-to-Pan in single preview
  const handlePreviewPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (viewMode !== 'single' || !previewCanvasRef.current || !sourceCanvasRef.current) return;

    if (wandActive) {
      const src = sourceCanvasRef.current;
      const disp = previewCanvasRef.current;
      const rect = disp.getBoundingClientRect();
      const px = ((e.clientX - rect.left) / rect.width) * preset.widthPx;
      const py = ((e.clientY - rect.top) / rect.height) * preset.heightPx;

      // Map single-ID pixel coords back to sourceCanvas coords
      const coverScale = Math.max(preset.widthPx / src.width, preset.heightPx / src.height) * zoom;
      const dw = src.width * coverScale;
      const dh = src.height * coverScale;
      const dx = (preset.widthPx - dw) / 2 + offset.x * preset.widthPx;
      const dy = (preset.heightPx - dh) / 2 + offset.y * preset.heightPx;
      const sx = (px - dx) / coverScale;
      const sy = (py - dy) / coverScale;

      if (sx >= 0 && sy >= 0 && sx < src.width && sy < src.height) {
        const ctx = src.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        const imgData = ctx.getImageData(0, 0, src.width, src.height);
        const erased = applyMagicWandErase(imgData.data, src.width, src.height, sx, sy, wandTolerance, true);
        if (erased > 0) {
          ctx.putImageData(imgData, 0, 0);
          setRenderTick(t => t + 1);
          setStatusMsg({ type: 'success', text: `Erased ${erased.toLocaleString()} background pixels.` });
        }
      }
      return;
    }

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panDragRef.current = { startX: e.clientX, startY: e.clientY, origX: offset.x, origY: offset.y };
  };

  const handlePreviewPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = panDragRef.current;
    const disp = previewCanvasRef.current;
    if (!drag || !disp) return;
    const rect = disp.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    setOffset({
      x: Math.max(-0.8, Math.min(0.8, drag.origX + (e.clientX - drag.startX) / rect.width)),
      y: Math.max(-0.8, Math.min(0.8, drag.origY + (e.clientY - drag.startY) / rect.height)),
    });
  };

  const handlePreviewPointerUp = () => {
    panDragRef.current = null;
  };

  // Export single or printable sheet
  const downloadCanvas = (canvas: HTMLCanvasElement | null, suffix: string, mime: 'image/jpeg' | 'image/png') => {
    if (!canvas) return;
    const ext = mime === 'image/png' ? 'png' : 'jpg';
    const url = canvas.toDataURL(mime, 0.95);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${fileName}_${suffix}.${ext}`;
    a.click();
  };

  const downloadSheetPdf = async () => {
    const sheetCanvas = renderSheetCanvas();
    if (!sheetCanvas) return;
    try {
      const jpgBytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        sheetCanvas.toBlob(
          b => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('Encode failed'))),
          'image/jpeg',
          0.95
        );
      });
      const pdfDoc = await PDFDocument.create();
      const img = await pdfDoc.embedJpg(jpgBytes);
      const { sheet } = sheetLayout;
      const page = pdfDoc.addPage([sheet.widthPt, sheet.heightPt]);
      page.drawImage(img, { x: 0, y: 0, width: sheet.widthPt, height: sheet.heightPt });
      const pdfBytes = await pdfDoc.save();
      const blob = new Blob([pdfBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileName}_${preset.id}_${sheet.id}_sheet.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setStatusMsg({ type: 'error', text: 'Failed to generate print-ready PDF.' });
    }
  };

  if (!hasImage) {
    return (
      <div style={{ maxWidth: 680, margin: '0 auto' }}>
        {statusMsg && (
          <div className={`ie-alert ie-alert-${statusMsg.type}`} role="alert" style={{ marginBottom: '1rem' }}>
            <AlertCircle size={15} /><span>{statusMsg.text}</span>
          </div>
        )}
        <div
          className={`upload-area ${isDraggingFile ? 'dragging' : ''}`}
          onDragOver={e => { e.preventDefault(); setIsDraggingFile(true); }}
          onDragLeave={() => setIsDraggingFile(false)}
          onDrop={e => { e.preventDefault(); setIsDraggingFile(false); loadFile(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
        >
          <UserSquare2 size={48} className="upload-icon" aria-hidden="true" />
          <div>
            <p><strong style={{ color: 'var(--text-main)' }}>Upload Portrait Photo</strong> or drag &amp; drop</p>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Create exact 1×1, 2×2, or Passport photos with White/Blue/Red backdrop &amp; printable 4R/A4 sheets
            </p>
          </div>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => loadFile(e.target.files)} />
        </div>
      </div>
    );
  }

  return (
    <div className="ie-root">
      {statusMsg && (
        <div className={`ie-alert ie-alert-${statusMsg.type}`} role="status">
          {statusMsg.type === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span style={{ flex: 1 }}>{statusMsg.text}</span>
        </div>
      )}

      <div className="ie-layout">
        {/* Live Preview Stage */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div className="ie-toolbar">
            <div className="ie-toolbar-group">
              <button className={`ie-icon-btn ${viewMode === 'single' ? 'active' : ''}`} onClick={() => setViewMode('single')}>
                <UserSquare2 size={14} /> Single ({preset.label})
              </button>
              <button className={`ie-icon-btn ${viewMode === 'sheet' ? 'active' : ''}`} onClick={() => setViewMode('sheet')}>
                <Grid size={14} /> Print Sheet ({sheetLayout.totalCopies} copies)
              </button>
            </div>
            <div className="ie-toolbar-group">
              <button className="ie-icon-btn" onClick={() => fileInputRef.current?.click()}>
                <Upload size={14} /> Change Photo
              </button>
              <button className="ie-icon-btn" onClick={() => { setHasImage(false); setStatusMsg(null); }} aria-label="Clear photo">
                <Trash2 size={14} />
              </button>
              <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => loadFile(e.target.files)} />
            </div>
          </div>

          <div className="ie-stage">
            <div className="ie-canvas-wrap">
              <canvas
                ref={previewCanvasRef}
                className="ie-canvas"
                style={{
                  cursor: viewMode === 'single' ? (wandActive ? 'crosshair' : 'grab') : 'default',
                  touchAction: viewMode === 'single' ? 'none' : 'auto',
                }}
                onPointerDown={handlePreviewPointerDown}
                onPointerMove={handlePreviewPointerMove}
                onPointerUp={handlePreviewPointerUp}
                onPointerCancel={handlePreviewPointerUp}
              />
            </div>
          </div>
          {viewMode === 'single' && (
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>
              {wandActive
                ? 'Magic Wand active: click/tap the background around the person to erase it.'
                : 'Drag the photo to center the face inside the blue oval guide, then adjust zoom.'}
            </p>
          )}
        </div>

        {/* Controls Sidebar */}
        <aside className="ie-sidebar">
          <div className="ie-panel">
            {/* 1. ID Photo Size */}
            <div className="ie-section">
              <label className="ie-label">ID Photo Size (300 DPI)</label>
              <div className="ie-btn-grid-2">
                {ID_PRESETS.map(p => (
                  <button
                    key={p.id}
                    className={`ie-preset-card ${presetId === p.id ? 'active' : ''}`}
                    onClick={() => setPresetId(p.id)}
                  >
                    <strong>{p.label}</strong>
                    <span>{p.sublabel}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* 2. Zoom & Framing */}
            <div className="ie-slider-row">
              <div className="ie-slider-head">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                  <ZoomIn size={13} /> Zoom
                </span>
                <span>{Math.round(zoom * 100)}%</span>
              </div>
              <input
                type="range"
                className="range-input"
                min={50}
                max={250}
                value={Math.round(zoom * 100)}
                onChange={e => setZoom(Number(e.target.value) / 100)}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '0.25rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={showGuide} onChange={e => setShowGuide(e.target.checked)} />
                  Face alignment guide
                </label>
                <button className="ie-link-btn" onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }); }}>
                  <RotateCcw size={12} /> Center
                </button>
              </div>
            </div>

            {/* 3. Background Removal & Backdrop Color */}
            <div className="ie-card" style={{ display: 'flex', flexDirection: 'column', gap: '0.55rem' }}>
              <label className="ie-label" style={{ margin: 0 }}>Background Removal &amp; Color</label>
              <div style={{ display: 'flex', gap: '0.4rem' }}>
                <button
                  className="download-btn"
                  style={{ flex: 1, padding: '0.55rem 0.6rem', fontSize: '0.78rem' }}
                  onClick={handleAiRemoveBg}
                  disabled={isRemovingBg}
                >
                  {isRemovingBg ? <Loader2 className="spinner" size={14} /> : <Sparkles size={14} />}
                  {isRemovingBg ? 'Removing…' : 'AI Remove BG'}
                </button>
                <button
                  className={`ie-chip-btn ${wandActive ? 'active' : ''}`}
                  style={{ padding: '0.55rem 0.65rem' }}
                  onClick={() => { setViewMode('single'); setWandActive(v => !v); }}
                  title="Offline Magic Wand — tap background to erase"
                >
                  <Wand2 size={14} /> Wand
                </button>
              </div>

              {wandActive && (
                <div className="ie-slider-row">
                  <div className="ie-slider-head">
                    <span>Wand Tolerance</span>
                    <span>{wandTolerance}%</span>
                  </div>
                  <input type="range" className="range-input" min={5} max={70} value={wandTolerance} onChange={e => setWandTolerance(Number(e.target.value))} />
                </div>
              )}

              <button className="ie-link-btn" onClick={() => setShowKeyInput(v => !v)}>
                <KeyRound size={12} /> {showKeyInput ? 'Hide API Key' : 'Custom withoutBG API Key'}
              </button>
              {showKeyInput && (
                <input
                  type="password"
                  className="ie-input"
                  placeholder="sk_... (saved in browser)"
                  value={userApiKey}
                  onChange={e => {
                    setUserApiKey(e.target.value);
                    if (e.target.value.trim()) localStorage.setItem(API_KEY_STORAGE, e.target.value.trim());
                    else localStorage.removeItem(API_KEY_STORAGE);
                  }}
                />
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginTop: '0.2rem' }}>
                {BACKDROP_SWATCHES.map(sw => (
                  <button
                    key={sw.color}
                    title={sw.label}
                    onClick={() => setBgColor(sw.color)}
                    style={{
                      width: 28, height: 28, borderRadius: 6, background: sw.color,
                      border: bgColor === sw.color ? '2px solid var(--primary)' : '1px solid var(--border)',
                      cursor: 'pointer'
                    }}
                    aria-label={`Backdrop ${sw.label}`}
                  />
                ))}
                <input
                  type="color"
                  value={bgColor}
                  onChange={e => setBgColor(e.target.value)}
                  style={{ width: 32, height: 28, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                  aria-label="Custom backdrop color"
                />
              </div>
            </div>

            {/* 4. Printable Paper Sheet */}
            <div className="ie-section">
              <label className="ie-label">Printable Sheet Layout ({sheetLayout.totalCopies} copies)</label>
              <div className="ie-btn-grid-3">
                {SHEET_PRESETS.map(s => (
                  <button
                    key={s.id}
                    className={`ie-chip-btn ${sheetId === s.id ? 'active' : ''}`}
                    onClick={() => { setSheetId(s.id); setViewMode('sheet'); }}
                  >
                    {s.id.toUpperCase()}
                  </button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.76rem', color: 'var(--text-secondary)', cursor: 'pointer', marginTop: '0.25rem' }}>
                <input type="checkbox" checked={showCutMarks} onChange={e => setShowCutMarks(e.target.checked)} />
                Draw dashed cutting guides
              </label>
            </div>

            {/* 5. Export Buttons */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.4rem' }}>
                <button className="ie-export-btn" onClick={() => downloadCanvas(renderSingleIdCanvas(), preset.id, 'image/jpeg')}>
                  <Download size={14} /> Single JPG
                </button>
                <button className="ie-export-btn" onClick={() => downloadCanvas(renderSingleIdCanvas(), preset.id, 'image/png')}>
                  <Download size={14} /> Single PNG
                </button>
              </div>
              <button className="download-btn" style={{ padding: '0.7rem', fontSize: '0.85rem' }} onClick={downloadSheetPdf}>
                <FileText size={16} /> Print Sheet PDF ({sheetLayout.sheet.id.toUpperCase()} · {sheetLayout.totalCopies}×)
              </button>
              <button className="ie-secondary-btn" onClick={() => downloadCanvas(renderSheetCanvas(), `${preset.id}_${sheetLayout.sheet.id}`, 'image/jpeg')}>
                Download Sheet JPG (300 DPI)
              </button>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
