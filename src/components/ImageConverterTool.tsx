import { useState, useRef } from 'react';
import { Upload, Download, Trash2, CheckCircle2, Loader2, Repeat, X } from 'lucide-react';
import JSZip from 'jszip';

type TargetFmt = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/bmp';

interface ConvertItem {
  id: string;
  file: File;
  status: 'idle' | 'converting' | 'done' | 'error';
  outBlob?: Blob;
  outName?: string;
  outSize?: number;
}

const FORMAT_OPTIONS: { id: TargetFmt; label: string; ext: string }[] = [
  { id: 'image/png',  label: 'PNG',  ext: 'png' },
  { id: 'image/jpeg', label: 'JPG',  ext: 'jpg' },
  { id: 'image/webp', label: 'WebP', ext: 'webp' },
  { id: 'image/bmp',  label: 'BMP',  ext: 'bmp' },
];

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.min(2, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
};

// Minimal 24-bit uncompressed BMP encoder (browsers don't natively encode BMP in toBlob)
function canvasToBmpBlob(canvas: HTMLCanvasElement): Blob {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rowSize = Math.floor((24 * w + 31) / 32) * 4;
  const pixelBytes = rowSize * h;
  const buf = new ArrayBuffer(54 + pixelBytes);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  view.setUint16(0, 0x424d, false); // 'BM'
  view.setUint32(2, 54 + pixelBytes, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);

  for (let y = 0; y < h; y++) {
    const srcRow = (h - 1 - y) * w * 4;
    const dstRow = 54 + y * rowSize;
    for (let x = 0; x < w; x++) {
      const sp = srcRow + x * 4;
      const dp = dstRow + x * 3;
      bytes[dp]     = rgba[sp + 2]; // B
      bytes[dp + 1] = rgba[sp + 1]; // G
      bytes[dp + 2] = rgba[sp];     // R
    }
  }
  return new Blob([buf], { type: 'image/bmp' });
}

export default function ImageConverterTool() {
  const [items, setItems]           = useState<ConvertItem[]>([]);
  const [targetFmt, setTargetFmt]   = useState<TargetFmt>('image/webp');
  const [quality, setQuality]       = useState(90);
  const [fillColor, setFillColor]   = useState('#FFFFFF');
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files || !files.length) return;
    const valid = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!valid.length) return;
    setItems(prev => [
      ...prev,
      ...valid.map(file => ({
        id: Math.random().toString(36).substring(2, 11),
        file,
        status: 'idle' as const,
      })),
    ]);
  };

  const convertOne = (file: File, fmt: TargetFmt, q: number, bg: string): Promise<{ blob: Blob; name: string }> =>
    new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth || img.width;
        c.height = img.naturalHeight || img.height;
        const ctx = c.getContext('2d');
        if (!ctx) { URL.revokeObjectURL(url); reject(new Error('Canvas error')); return; }

        if (fmt === 'image/jpeg' || fmt === 'image/bmp') {
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, c.width, c.height);
        }
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);

        const ext = FORMAT_OPTIONS.find(o => o.id === fmt)?.ext || 'png';
        const base = file.name.replace(/\.[^.]+$/, '');
        const outName = `${base}.${ext}`;

        if (fmt === 'image/bmp') {
          resolve({ blob: canvasToBmpBlob(c), name: outName });
          return;
        }
        c.toBlob(
          blob => (blob ? resolve({ blob, name: outName }) : reject(new Error('Encode failed'))),
          fmt,
          fmt === 'image/png' ? undefined : q / 100
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Decode failed')); };
      img.src = url;
    });

  const handleConvertAll = async () => {
    if (!items.length) return;
    setIsProcessing(true);
    for (const item of items) {
      setItems(prev => prev.map(i => (i.id === item.id ? { ...i, status: 'converting' } : i)));
      try {
        const { blob, name } = await convertOne(item.file, targetFmt, quality, fillColor);
        setItems(prev => prev.map(i =>
          i.id === item.id ? { ...i, status: 'done', outBlob: blob, outName: name, outSize: blob.size } : i
        ));
      } catch {
        setItems(prev => prev.map(i => (i.id === item.id ? { ...i, status: 'error' } : i)));
      }
    }
    setIsProcessing(false);
  };

  const downloadItem = (item: ConvertItem) => {
    if (!item.outBlob || !item.outName) return;
    const url = URL.createObjectURL(item.outBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.outName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllZip = async () => {
    const done = items.filter(i => i.status === 'done' && i.outBlob && i.outName);
    if (!done.length) return;
    if (done.length === 1) { downloadItem(done[0]); return; }
    const zip = new JSZip();
    done.forEach(d => zip.file(d.outName!, d.outBlob!));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'converted_images.zip';
    a.click();
    URL.revokeObjectURL(url);
  };

  const doneCount = items.filter(i => i.status === 'done').length;

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <div className="tool-controls-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="setting-group">
          <label>Convert To Format</label>
          <div className="ie-btn-grid-4">
            {FORMAT_OPTIONS.map(f => (
              <button
                key={f.id}
                type="button"
                className={`ie-chip-btn ${targetFmt === f.id ? 'active' : ''}`}
                onClick={() => setTargetFmt(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        {(targetFmt === 'image/jpeg' || targetFmt === 'image/webp') && (
          <div className="ie-slider-row">
            <div className="ie-slider-head">
              <span>Output Quality</span>
              <span>{quality}%</span>
            </div>
            <input type="range" className="range-input" min={40} max={100} value={quality} onChange={e => setQuality(Number(e.target.value))} />
          </div>
        )}

        {(targetFmt === 'image/jpeg' || targetFmt === 'image/bmp') && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
            <span className="ie-label" style={{ margin: 0 }}>Transparent Background Fill Color</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="color"
                value={fillColor}
                onChange={e => setFillColor(e.target.value)}
                style={{ width: 36, height: 30, border: '1px solid var(--border)', borderRadius: 6, background: 'none', cursor: 'pointer' }}
                aria-label="Background fill color"
              />
              <span style={{ fontSize: '0.8rem', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{fillColor.toUpperCase()}</span>
            </div>
          </div>
        )}

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
          <Upload size={40} className="upload-icon" aria-hidden="true" />
          <div>
            <p><strong style={{ color: 'var(--text-main)' }}>Drag &amp; Drop Images</strong> or click to browse</p>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Batch convert PNG, JPG, WebP, BMP, GIF, AVIF or SVG — 100% offline
            </p>
          </div>
          <input ref={fileInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
        </div>

        {items.length > 0 && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', justifyContent: 'space-between', alignItems: 'center' }}>
              <button className="download-btn" style={{ flex: 1, minWidth: 180, padding: '0.7rem' }} onClick={handleConvertAll} disabled={isProcessing}>
                {isProcessing ? <Loader2 className="spinner" size={16} /> : <Repeat size={16} />}
                {isProcessing ? 'Converting…' : `Convert ${items.length} Image${items.length > 1 ? 's' : ''}`}
              </button>
              {doneCount > 0 && (
                <button className="btn-primary" style={{ padding: '0.7rem 1rem', fontSize: '0.85rem' }} onClick={downloadAllZip}>
                  <Download size={15} /> {doneCount > 1 ? `Download ZIP (${doneCount})` : 'Download'}
                </button>
              )}
              <button className="ie-secondary-btn" onClick={() => setItems([])}>Clear</button>
            </div>

            <div className="file-list" style={{ marginTop: '0.25rem' }}>
              {items.map(item => (
                <div key={item.id} className="file-item">
                  <div className="file-info">
                    {item.status === 'converting' ? <Loader2 className="spinner" size={17} color="var(--primary)" /> :
                     item.status === 'done' ? <CheckCircle2 size={17} color="var(--success)" /> :
                     item.status === 'error' ? <X size={17} color="var(--error)" /> :
                     <Repeat size={17} color="var(--text-muted)" />}
                    <div className="file-details">
                      <h4>{item.outName || item.file.name}</h4>
                      <p>
                        {formatSize(item.file.size)}
                        {item.outSize !== undefined && <> → <span style={{ color: 'var(--success)' }}>{formatSize(item.outSize)}</span></>}
                      </p>
                    </div>
                  </div>
                  <div className="action-btns">
                    {item.status === 'done' && (
                      <button className="btn-icon" onClick={() => downloadItem(item)} title="Download" aria-label="Download converted image">
                        <Download size={15} />
                      </button>
                    )}
                    <button className="btn-icon" onClick={() => setItems(prev => prev.filter(i => i.id !== item.id))} title="Remove" aria-label="Remove image">
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
