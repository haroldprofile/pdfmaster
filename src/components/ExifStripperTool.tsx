import { useState, useRef } from 'react';
import {
  Download, Trash2, ShieldOff, ShieldCheck, MapPin, Loader2, CheckCircle2, AlertTriangle
} from 'lucide-react';
import JSZip from 'jszip';
import { parseImageMetadata, type ParsedImageMetadata } from '../utils/imageToolsUtils';

interface ExifItem {
  id: string;
  file: File;
  width: number;
  height: number;
  meta: ParsedImageMetadata;
  strippedBlob?: Blob;
  verifiedClean?: boolean;
}

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.min(2, Math.floor(Math.log(bytes) / Math.log(k)));
  return `${(bytes / Math.pow(k, i)).toFixed(i === 0 ? 0 : 1)} ${sizes[i]}`;
};

export default function ExifStripperTool() {
  const [items, setItems]               = useState<ExifItem[]>([]);
  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [isStripping, setIsStripping]   = useState(false);
  const [isDragging, setIsDragging]     = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const valid = Array.from(files).filter(f => f.type.startsWith('image/'));
    for (const file of valid) {
      const buf = await file.arrayBuffer();
      const meta = parseImageMetadata(buf);
      const dims = await new Promise<{ w: number; h: number }>(resolve => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
        img.onerror = () => { resolve({ w: 0, h: 0 }); URL.revokeObjectURL(url); };
        img.src = url;
      });
      const id = Math.random().toString(36).substring(2, 11);
      setItems(prev => [...prev, { id, file, width: dims.w, height: dims.h, meta }]);
      setSelectedId(prev => prev || id);
    }
  };

  // Re-encode via Canvas to guarantee 100% removal of EXIF, GPS, XMP, IPTC & PNG text metadata
  const stripOne = async (item: ExifItem): Promise<{ blob: Blob; clean: boolean }> => {
    const url = URL.createObjectURL(item.file);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = reject;
        el.src = url;
      });
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width;
      c.height = img.naturalHeight || img.height;
      c.getContext('2d')?.drawImage(img, 0, 0);

      const mime = item.file.type === 'image/png' ? 'image/png' : item.file.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
      const blob = await new Promise<Blob>((resolve, reject) => {
        c.toBlob(b => (b ? resolve(b) : reject(new Error('Encode failed'))), mime, mime === 'image/png' ? undefined : 0.95);
      });
      // Re-parse stripped bytes to verify zero EXIF/GPS tags remain
      const verify = parseImageMetadata(await blob.arrayBuffer());
      return { blob, clean: !verify.hasExif && !verify.hasGps && verify.tags.length === 0 };
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const handleStripAll = async () => {
    if (!items.length) return;
    setIsStripping(true);
    for (const it of items) {
      try {
        const { blob, clean } = await stripOne(it);
        setItems(prev => prev.map(x => (x.id === it.id ? { ...x, strippedBlob: blob, verifiedClean: clean } : x)));
      } catch {
        // leave unstripped
      }
    }
    setIsStripping(false);
  };

  const downloadOne = (it: ExifItem) => {
    if (!it.strippedBlob) return;
    const url = URL.createObjectURL(it.strippedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `clean_${it.file.name}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAllZip = async () => {
    const cleaned = items.filter(i => i.strippedBlob);
    if (!cleaned.length) return;
    if (cleaned.length === 1) { downloadOne(cleaned[0]); return; }
    const zip = new JSZip();
    cleaned.forEach(c => zip.file(`clean_${c.file.name}`, c.strippedBlob!));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'cleaned_images.zip';
    a.click();
    URL.revokeObjectURL(url);
  };

  const selected = items.find(i => i.id === selectedId) || items[0] || null;
  const cleanedCount = items.filter(i => i.strippedBlob).length;

  return (
    <div className="tool-split-layout">
      {/* Left: Upload & File Queue */}
      <div className="tool-controls-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
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
          <ShieldOff size={44} className="upload-icon" aria-hidden="true" />
          <div>
            <p><strong style={{ color: 'var(--text-main)' }}>Upload Photos to Inspect &amp; Clean</strong></p>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              Detects hidden GPS coordinates, camera model &amp; EXIF tags — strips everything locally
            </p>
          </div>
          <input ref={fileInputRef} type="file" multiple accept="image/*" style={{ display: 'none' }} onChange={e => addFiles(e.target.files)} />
        </div>

        {items.length > 0 && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
              <button className="download-btn" style={{ flex: 1, minWidth: 160, padding: '0.7rem', fontSize: '0.875rem' }} onClick={handleStripAll} disabled={isStripping}>
                {isStripping ? <Loader2 className="spinner" size={16} /> : <ShieldOff size={16} />}
                {isStripping ? 'Stripping Metadata…' : `Strip Metadata (${items.length})`}
              </button>
              {cleanedCount > 0 && (
                <button className="btn-primary" style={{ padding: '0.7rem 1rem', fontSize: '0.85rem' }} onClick={downloadAllZip}>
                  <Download size={15} /> {cleanedCount > 1 ? `Download ZIP (${cleanedCount})` : 'Download Clean'}
                </button>
              )}
            </div>

            <div className="file-list" style={{ marginTop: 0 }}>
              {items.map(it => (
                <div
                  key={it.id}
                  className="file-item"
                  style={{ cursor: 'pointer', borderColor: selected?.id === it.id ? 'var(--primary)' : undefined }}
                  onClick={() => setSelectedId(it.id)}
                >
                  <div className="file-info">
                    {it.verifiedClean ? <CheckCircle2 size={17} color="var(--success)" /> :
                     it.meta.hasGps ? <MapPin size={17} color="var(--error)" /> :
                     it.meta.hasExif ? <AlertTriangle size={17} color="var(--warning)" /> :
                     <ShieldCheck size={17} color="var(--success)" />}
                    <div className="file-details">
                      <h4>{it.file.name}</h4>
                      <p>
                        {formatSize(it.file.size)} · {it.width}×{it.height}px ·{' '}
                        {it.verifiedClean ? (
                          <span style={{ color: 'var(--success)', fontWeight: 700 }}>Metadata Stripped (0 tags)</span>
                        ) : it.meta.hasGps ? (
                          <span style={{ color: 'var(--error)', fontWeight: 700 }}>GPS + {it.meta.tags.length} tags found</span>
                        ) : it.meta.tags.length > 0 ? (
                          <span style={{ color: 'var(--warning)', fontWeight: 600 }}>{it.meta.tags.length} metadata tags</span>
                        ) : (
                          <span>No EXIF tags detected</span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="action-btns">
                    {it.strippedBlob && (
                      <button className="btn-icon" onClick={e => { e.stopPropagation(); downloadOne(it); }} title="Download clean copy">
                        <Download size={15} />
                      </button>
                    )}
                    <button
                      className="btn-icon"
                      onClick={e => { e.stopPropagation(); setItems(prev => prev.filter(x => x.id !== it.id)); }}
                      title="Remove"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {/* Right: Metadata Inspector */}
      <div className="tool-preview-panel">
        <div className="preview-panel-header">
          <h4>Metadata Inspector</h4>
          {selected && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>{selected.file.type || 'image'}</span>}
        </div>
        <div style={{ padding: '1.25rem', minHeight: 360, maxHeight: 520, overflowY: 'auto' }}>
          {!selected ? (
            <div className="preview-empty" style={{ height: 300 }}>
              <ShieldCheck size={44} aria-hidden="true" />
              <p>Upload a photo to inspect camera, software &amp; GPS metadata</p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              {selected.verifiedClean ? (
                <div className="ie-alert ie-alert-success">
                  <CheckCircle2 size={16} />
                  <span><strong>Verified Clean:</strong> All EXIF, GPS, and embedded text chunks have been stripped from the output file.</span>
                </div>
              ) : selected.meta.hasGps ? (
                <div className="ie-alert ie-alert-error">
                  <MapPin size={16} />
                  <span><strong>Privacy Alert:</strong> Exact GPS location ({selected.meta.gps?.lat}, {selected.meta.gps?.lon}) is embedded in this photo!</span>
                </div>
              ) : null}

              <div className="ie-info-box" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem' }}>
                <div><span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', display: 'block' }}>Dimensions</span><strong>{selected.width} × {selected.height} px</strong></div>
                <div><span style={{ color: 'var(--text-muted)', fontSize: '0.72rem', display: 'block' }}>File Size</span><strong>{formatSize(selected.file.size)}</strong></div>
              </div>

              {selected.meta.tags.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                  <span className="ie-label">Detected Embedded Tags ({selected.meta.tags.length})</span>
                  {selected.meta.tags.map((tag, idx) => (
                    <div
                      key={`${tag.key}-${idx}`}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        padding: '0.5rem 0.75rem',
                        borderRadius: 'var(--radius-xs)',
                        background: tag.sensitive ? 'var(--error-bg)' : 'var(--bg)',
                        border: `1px solid ${tag.sensitive ? 'var(--error)' : 'var(--border)'}`,
                        fontSize: '0.8rem',
                      }}
                    >
                      <span style={{ fontWeight: 700, color: tag.sensitive ? 'var(--error)' : 'var(--text-secondary)' }}>{tag.key}</span>
                      <span style={{ color: 'var(--text-main)', textAlign: 'right', wordBreak: 'break-word', fontFamily: 'monospace' }}>{tag.value}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="ie-info-box">
                  No standard EXIF / GPS / PNG text tags detected. You can still click <strong>Strip Metadata</strong> to re-encode a clean image without hidden XMP/IPTC blocks.
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
