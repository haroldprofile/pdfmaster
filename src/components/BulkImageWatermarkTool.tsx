import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Upload, Download, Trash2, Droplets, Type, Image as ImageIcon, Loader2
} from 'lucide-react';
import JSZip from 'jszip';

type WmPosition = 'diagonal' | 'tiled' | 'bottom-right' | 'bottom-left' | 'top-right' | 'center';

interface WmItem {
  id: string;
  file: File;
  url: string;
  img: HTMLImageElement;
}

const POSITIONS: { id: WmPosition; label: string }[] = [
  { id: 'diagonal',     label: 'Diagonal' },
  { id: 'tiled',        label: 'Tiled 3×3' },
  { id: 'center',       label: 'Center' },
  { id: 'bottom-right', label: 'Bottom Right' },
  { id: 'bottom-left',  label: 'Bottom Left' },
  { id: 'top-right',    label: 'Top Right' },
];

export default function BulkImageWatermarkTool() {
  const [items, setItems]             = useState<WmItem[]>([]);
  const [selectedId, setSelectedId]   = useState<string | null>(null);
  const [wmType, setWmType]           = useState<'text' | 'image'>('text');
  const [text, setText]               = useState('© PDFMASTER');
  const [color, setColor]             = useState('#FFFFFF');
  const [fontSize, setFontSize]       = useState(42);
  const [opacity, setOpacity]         = useState(35);
  const [position, setPosition]       = useState<WmPosition>('diagonal');
  const [logoImg, setLogoImg]         = useState<HTMLImageElement | null>(null);
  const [logoName, setLogoName]       = useState('');
  const [logoScale, setLogoScale]     = useState(25); // % of image width
  const [isExporting, setIsExporting] = useState(false);
  const [isDragging, setIsDragging]   = useState(false);

  const previewRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .forEach(file => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          const id = Math.random().toString(36).substring(2, 11);
          setItems(prev => {
            const next = [...prev, { id, file, url, img }];
            return next;
          });
          setSelectedId(prev => prev || id);
        };
        img.src = url;
      });
  };

  const handleLogoUpload = (files: FileList | null) => {
    if (!files || !files.length) return;
    const f = files[0];
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      setLogoImg(img);
      setLogoName(f.name);
      URL.revokeObjectURL(url);
    };
    img.src = url;
  };

  const stampOnCanvas = useCallback((canvas: HTMLCanvasElement, source: HTMLImageElement) => {
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(source, 0, 0, w, h);

    ctx.save();
    ctx.globalAlpha = opacity / 100;
    const pad = Math.round(Math.min(w, h) * 0.04);

    if (wmType === 'text' && text.trim()) {
      const scaledPx = Math.max(12, Math.round((fontSize / 800) * Math.max(w, h)));
      ctx.font = `700 ${scaledPx}px Inter, system-ui, sans-serif`;
      ctx.fillStyle = color;
      ctx.shadowColor = 'rgba(0,0,0,0.35)';
      ctx.shadowBlur = Math.max(2, scaledPx * 0.08);
      ctx.textBaseline = 'middle';

      if (position === 'diagonal' || position === 'center') {
        ctx.translate(w / 2, h / 2);
        if (position === 'diagonal') ctx.rotate(-Math.PI / 6);
        ctx.textAlign = 'center';
        ctx.fillText(text.trim(), 0, 0);
      } else if (position === 'tiled') {
        const tilePx = Math.max(10, Math.round(scaledPx * 0.55));
        ctx.font = `700 ${tilePx}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            ctx.save();
            ctx.translate((w / 3) * (c + 0.5), (h / 3) * (r + 0.5));
            ctx.rotate(-Math.PI / 6);
            ctx.fillText(text.trim(), 0, 0);
            ctx.restore();
          }
        }
      } else if (position === 'bottom-right') {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(text.trim(), w - pad, h - pad);
      } else if (position === 'bottom-left') {
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(text.trim(), pad, h - pad);
      } else if (position === 'top-right') {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(text.trim(), w - pad, pad);
      }
    } else if (wmType === 'image' && logoImg) {
      const lw = Math.round(w * (logoScale / 100));
      const lh = Math.round((logoImg.naturalHeight / logoImg.naturalWidth) * lw);

      if (position === 'diagonal' || position === 'center') {
        ctx.translate(w / 2, h / 2);
        if (position === 'diagonal') ctx.rotate(-Math.PI / 6);
        ctx.drawImage(logoImg, -lw / 2, -lh / 2, lw, lh);
      } else if (position === 'tiled') {
        const tw = Math.round(lw * 0.55);
        const th = Math.round(lh * 0.55);
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 3; c++) {
            ctx.save();
            ctx.translate((w / 3) * (c + 0.5), (h / 3) * (r + 0.5));
            ctx.rotate(-Math.PI / 6);
            ctx.drawImage(logoImg, -tw / 2, -th / 2, tw, th);
            ctx.restore();
          }
        }
      } else if (position === 'bottom-right') {
        ctx.drawImage(logoImg, w - lw - pad, h - lh - pad, lw, lh);
      } else if (position === 'bottom-left') {
        ctx.drawImage(logoImg, pad, h - lh - pad, lw, lh);
      } else if (position === 'top-right') {
        ctx.drawImage(logoImg, w - lw - pad, pad, lw, lh);
      }
    }
    ctx.restore();
  }, [wmType, text, color, fontSize, opacity, position, logoImg, logoScale]);

  const activeItem = items.find(i => i.id === selectedId) || items[0] || null;

  useEffect(() => {
    if (previewRef.current && activeItem) {
      stampOnCanvas(previewRef.current, activeItem.img);
    }
  }, [activeItem, stampOnCanvas]);

  const exportAll = async () => {
    if (!items.length) return;
    setIsExporting(true);
    try {
      const off = document.createElement('canvas');
      if (items.length === 1) {
        stampOnCanvas(off, items[0].img);
        const url = off.toDataURL('image/png');
        const a = document.createElement('a');
        a.href = url;
        a.download = `watermarked_${items[0].file.name.replace(/\.[^.]+$/, '')}.png`;
        a.click();
        return;
      }
      const zip = new JSZip();
      for (const it of items) {
        stampOnCanvas(off, it.img);
        const blob = await new Promise<Blob | null>(res => off.toBlob(res, 'image/png'));
        if (blob) zip.file(`watermarked_${it.file.name.replace(/\.[^.]+$/, '')}.png`, blob);
      }
      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'watermarked_images.zip';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="ie-layout">
      {/* Live Preview */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {items.length === 0 ? (
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
            <Droplets size={48} className="upload-icon" aria-hidden="true" />
            <div>
              <p><strong style={{ color: 'var(--text-main)' }}>Upload Images to Watermark</strong></p>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Stamp text or a transparent logo across multiple photos at once
              </p>
            </div>
          </div>
        ) : (
          <>
            <div className="ie-toolbar">
              <div className="ie-toolbar-group">
                <button className="ie-icon-btn" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={14} /> Add More
                </button>
                <button className="ie-icon-btn" onClick={() => { items.forEach(i => URL.revokeObjectURL(i.url)); setItems([]); setSelectedId(null); }}>
                  <Trash2 size={14} /> Clear
                </button>
              </div>
              <button
                className="ie-export-btn primary"
                onClick={exportAll}
                disabled={isExporting || (wmType === 'image' && !logoImg)}
              >
                {isExporting ? <Loader2 className="spinner" size={14} /> : <Download size={14} />}
                {items.length > 1 ? `Export ZIP (${items.length})` : 'Download PNG'}
              </button>
            </div>
            <div className="ie-stage">
              <div className="ie-canvas-wrap">
                <canvas ref={previewRef} className="ie-canvas" />
              </div>
            </div>
          </>
        )}
        <input ref={fileInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
      </div>

      {/* Sidebar Controls */}
      <aside className="ie-sidebar">
        <div className="ie-panel">
          <div className="ie-btn-grid-2">
            <button className={`ie-chip-btn ${wmType === 'text' ? 'active' : ''}`} onClick={() => setWmType('text')}>
              <Type size={14} /> Text
            </button>
            <button className={`ie-chip-btn ${wmType === 'image' ? 'active' : ''}`} onClick={() => setWmType('image')}>
              <ImageIcon size={14} /> Logo
            </button>
          </div>

          {wmType === 'text' ? (
            <>
              <div className="ie-section">
                <label className="ie-label">Watermark Text</label>
                <input className="ie-input" value={text} onChange={e => setText(e.target.value)} placeholder="e.g. CONFIDENTIAL" />
              </div>
              <div className="ie-slider-row">
                <div className="ie-slider-head"><span>Font Size</span><span>{fontSize}px</span></div>
                <input type="range" className="range-input" min={16} max={120} value={fontSize} onChange={e => setFontSize(Number(e.target.value))} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span className="ie-label" style={{ margin: 0 }}>Text Color</span>
                <input
                  type="color"
                  value={color}
                  onChange={e => setColor(e.target.value)}
                  style={{ width: 36, height: 30, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                  aria-label="Watermark text color"
                />
              </div>
            </>
          ) : (
            <>
              <button className="ie-chip-btn" style={{ width: '100%', padding: '0.6rem' }} onClick={() => logoInputRef.current?.click()}>
                <Upload size={14} /> {logoName || 'Upload Logo PNG'}
              </button>
              <input ref={logoInputRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={e => handleLogoUpload(e.target.files)} />
              <div className="ie-slider-row">
                <div className="ie-slider-head"><span>Logo Width</span><span>{logoScale}%</span></div>
                <input type="range" className="range-input" min={8} max={70} value={logoScale} onChange={e => setLogoScale(Number(e.target.value))} />
              </div>
            </>
          )}

          <div className="ie-section">
            <label className="ie-label">Position</label>
            <div className="ie-btn-grid-3">
              {POSITIONS.map(p => (
                <button key={p.id} className={`ie-chip-btn ${position === p.id ? 'active' : ''}`} onClick={() => setPosition(p.id)}>
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="ie-slider-row">
            <div className="ie-slider-head"><span>Opacity</span><span>{opacity}%</span></div>
            <input type="range" className="range-input" min={5} max={90} value={opacity} onChange={e => setOpacity(Number(e.target.value))} />
          </div>

          {items.length > 0 && (
            <div className="ie-section">
              <label className="ie-label">Images ({items.length}) — click to preview</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: 200, overflowY: 'auto' }}>
                {items.map(it => (
                  <div
                    key={it.id}
                    className="file-item"
                    style={{
                      padding: '0.45rem 0.6rem',
                      cursor: 'pointer',
                      borderColor: activeItem?.id === it.id ? 'var(--primary)' : undefined,
                    }}
                    onClick={() => setSelectedId(it.id)}
                  >
                    <img src={it.url} alt="" style={{ width: 28, height: 28, objectFit: 'cover', borderRadius: 4, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: '0.78rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-secondary)' }}>
                      {it.file.name}
                    </span>
                    <button
                      className="btn-icon"
                      onClick={e => {
                        e.stopPropagation();
                        URL.revokeObjectURL(it.url);
                        setItems(prev => prev.filter(x => x.id !== it.id));
                      }}
                      aria-label="Remove image"
                    >
                      <Trash2 size={13} />
                    </button>
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
