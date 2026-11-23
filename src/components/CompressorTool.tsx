import { useState, useRef, useEffect } from 'react';
import {
  Upload, Download, Loader2, CheckCircle2,
  Trash2, Eye, X, FileImage, RefreshCw
} from 'lucide-react';
import imageCompression, { type Options as ImageCompressionOptions } from 'browser-image-compression';
import { PDFDocument, PDFRawStream, PDFName, PDFNumber } from 'pdf-lib';
import JSZip from 'jszip';
import { ReactCompareSlider, ReactCompareSliderImage } from 'react-compare-slider';

type Mode = 'image' | 'pdf';
type Status = 'pending' | 'processing' | 'done' | 'error';
type OutputFormat = 'original' | 'image/jpeg' | 'image/webp';

interface QueueItem {
  id: string;
  file: File;
  compressedBlob?: Blob;
  outputName?: string;
  status: Status;
  originalSize: number;
  compressedSize?: number;
  previewUrl?: string;
  originalUrl?: string;
}

const TARGET_PRESETS_KB = [
  { label: '50 KB',  kb: 50 },
  { label: '100 KB', kb: 100 },
  { label: '200 KB', kb: 200 },
  { label: '500 KB', kb: 500 },
  { label: '1 MB',   kb: 1024 },
  { label: 'No cap', kb: 0 },
];

const MAX_DIM_PRESETS = [
  { label: 'Original', px: 0 },
  { label: '1920px',   px: 1920 },
  { label: '1280px',   px: 1280 },
  { label: '800px',    px: 800 },
];

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

function getOutputFilename(originalName: string, format: OutputFormat): string {
  const base = originalName.replace(/\.[^.]+$/, '');
  if (format === 'image/jpeg') return `reduced_${base}.jpg`;
  if (format === 'image/webp') return `reduced_${base}.webp`;
  return `reduced_${originalName}`;
}

export default function CompressorTool({ defaultMode = 'image' }: { defaultMode?: Mode }) {
  const [mode, setMode]                     = useState<Mode>(defaultMode);
  const [queue, setQueue]                   = useState<QueueItem[]>([]);
  const [quality, setQuality]               = useState(0.8);
  const [targetKB, setTargetKB]             = useState<number>(500); // 0 = quality-only
  const [maxDim, setMaxDim]                 = useState<number>(1920); // 0 = keep original
  const [outputFormat, setOutputFormat]     = useState<OutputFormat>('original');
  const [pdfQuality, setPdfQuality]         = useState(0.6);
  const [settingsDirty, setSettingsDirty]   = useState(false);
  const [isDragging, setIsDragging]         = useState(false);
  const [previewItem, setPreviewItem]       = useState<QueueItem | null>(null);
  const [selectedPreview, setSelectedPreview] = useState<QueueItem | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setMode(defaultMode);
    setQueue([]);
    setSelectedPreview(null);
    setSettingsDirty(false);
  }, [defaultMode]);

  const downsampleImage = async (bytes: Uint8Array, width: number, height: number, scale: number, q: number): Promise<Uint8Array> => {
    return new Promise((resolve, reject) => {
      const blob = new Blob([bytes as any]);
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(width * scale);
        canvas.height = Math.floor(height * scale);
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('Canvas error')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((b) => {
          if (!b) { reject(new Error('Blob error')); return; }
          const reader = new FileReader();
          reader.onloadend = () => {
            resolve(new Uint8Array(reader.result as ArrayBuffer));
            URL.revokeObjectURL(url);
          };
          reader.readAsArrayBuffer(b);
        }, 'image/jpeg', q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Load error')); };
      img.src = url;
    });
  };

  const processImage = async (file: File) => {
    const options: ImageCompressionOptions = {
      useWebWorker: true,
      initialQuality: quality,
      maxIteration: 15,
    };
    if (targetKB > 0) {
      options.maxSizeMB = targetKB / 1024;
    }
    if (maxDim > 0) {
      options.maxWidthOrHeight = maxDim;
    }
    if (outputFormat !== 'original') {
      options.fileType = outputFormat;
    }
    return await imageCompression(file, options);
  };

  const processPdf = async (file: File) => {
    const arrayBuffer = await file.arrayBuffer();
    const pdfDoc = await PDFDocument.load(arrayBuffer);
    const enumerateIndirectObjects = pdfDoc.context.enumerateIndirectObjects();
    const scale = pdfQuality > 0.7 ? 1 : 0.7;

    for (const [ref, pdfObject] of enumerateIndirectObjects) {
      if (!(pdfObject instanceof PDFRawStream)) continue;
      const dict = pdfObject.dict;
      if (dict.get(PDFName.of('Subtype')) !== PDFName.of('Image')) continue;
      try {
        const width = (dict.get(PDFName.of('Width')) as PDFNumber).asNumber();
        const height = (dict.get(PDFName.of('Height')) as PDFNumber).asNumber();
        if (width > 100 && height > 100) {
          const compressedBytes = await downsampleImage(pdfObject.contents, width, height, scale, pdfQuality);
          const newDict = dict.clone();
          newDict.set(PDFName.of('Width'), PDFNumber.of(Math.floor(width * scale)));
          newDict.set(PDFName.of('Height'), PDFNumber.of(Math.floor(height * scale)));
          newDict.set(PDFName.of('Length'), PDFNumber.of(compressedBytes.length));
          newDict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
          pdfDoc.context.assign(ref, PDFRawStream.of(newDict, compressedBytes));
        }
      } catch (e) { console.warn('Skipping image...', e); }
    }
    const bytes = await pdfDoc.save({ useObjectStreams: true });
    return new Blob([bytes as any], { type: 'application/pdf' });
  };

  const handleFiles = (files: FileList) => {
    const newItems: QueueItem[] = Array.from(files).map(file => ({
      id: Math.random().toString(36).substring(2, 11),
      file,
      status: 'pending',
      originalSize: file.size,
      originalUrl: URL.createObjectURL(file)
    }));
    setQueue(prev => [...prev, ...newItems]);
  };

  const recompressAll = () => {
    setSettingsDirty(false);
    setSelectedPreview(null);
    setQueue(prev => prev.map(item => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return {
        ...item,
        status: 'pending',
        compressedBlob: undefined,
        compressedSize: undefined,
        previewUrl: undefined,
      };
    }));
  };

  useEffect(() => {
    const processQueue = async () => {
      const nextItem = queue.find(item => item.status === 'pending');
      if (!nextItem) return;

      setQueue(prev => prev.map(item =>
        item.id === nextItem.id ? { ...item, status: 'processing' } : item
      ));

      try {
        let compressedBlob: Blob;
        let outputName: string;
        if (mode === 'image') {
          compressedBlob = await processImage(nextItem.file);
          outputName = getOutputFilename(nextItem.file.name, outputFormat);
        } else {
          compressedBlob = await processPdf(nextItem.file);
          outputName = `compressed_${nextItem.file.name}`;
        }

        const newItem: QueueItem = {
          ...nextItem,
          status: 'done',
          compressedBlob,
          outputName,
          compressedSize: compressedBlob.size,
          previewUrl: URL.createObjectURL(compressedBlob)
        };

        setQueue(prev => prev.map(item =>
          item.id === nextItem.id ? newItem : item
        ));

        setSelectedPreview(prev => prev ? prev : newItem);
      } catch {
        setQueue(prev => prev.map(item =>
          item.id === nextItem.id ? { ...item, status: 'error' } : item
        ));
      }
    };
    processQueue();
  }, [queue, mode, quality, targetKB, maxDim, outputFormat, pdfQuality]);

  const downloadOne = (item: QueueItem) => {
    if (!item.compressedBlob) return;
    const url = URL.createObjectURL(item.compressedBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.outputName || `compressed_${item.file.name}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadAll = async () => {
    const doneItems = queue.filter(item => item.status === 'done' && item.compressedBlob);
    if (doneItems.length === 0) return;
    if (doneItems.length === 1) {
      downloadOne(doneItems[0]);
      return;
    }
    const zip = new JSZip();
    doneItems.forEach(item => zip.file(item.outputName || `compressed_${item.file.name}`, item.compressedBlob!));
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url; a.download = mode === 'image' ? 'reduced_images.zip' : 'compressed_files.zip'; a.click();
    URL.revokeObjectURL(url);
  };

  const markDirty = () => {
    if (queue.some(i => i.status === 'done' || i.status === 'error')) {
      setSettingsDirty(true);
    }
  };

  return (
    <>
      <div className="tool-split-layout">
        {/* ── Controls ── */}
        <div className="tool-controls-panel">
          <div className="tabs" role="tablist" aria-label="Compression mode">
            <button
              className={`tab ${mode === 'image' ? 'active' : ''}`}
              onClick={() => { setMode('image'); setQueue([]); setSelectedPreview(null); setSettingsDirty(false); }}
              role="tab" aria-selected={mode === 'image'} id="tab-image" aria-controls="panel-image"
            >
              <FileImage size={15} aria-hidden="true" /> Image Reducer
            </button>
            <button
              className={`tab ${mode === 'pdf' ? 'active' : ''}`}
              onClick={() => { setMode('pdf'); setQueue([]); setSelectedPreview(null); setSettingsDirty(false); }}
              role="tab" aria-selected={mode === 'pdf'} id="tab-pdf" aria-controls="panel-pdf"
            >
              PDF Documents
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginBottom: '1.25rem' }}>
            {mode === 'image' && (
              <>
                {/* Target File Size Presets + Custom KB */}
                <div className="setting-group">
                  <label htmlFor="target-kb-input">
                    Target Max File Size:{' '}
                    <strong style={{ color: 'var(--primary)' }}>
                      {targetKB > 0 ? (targetKB >= 1024 ? `${(targetKB / 1024).toFixed(1)} MB` : `${targetKB} KB`) : 'Quality only'}
                    </strong>
                  </label>
                  <div className="ie-btn-grid-3">
                    {TARGET_PRESETS_KB.map(p => (
                      <button
                        key={p.label}
                        type="button"
                        className={`ie-chip-btn ${targetKB === p.kb ? 'active' : ''}`}
                        onClick={() => { setTargetKB(p.kb); markDirty(); }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.25rem' }}>
                    <input
                      id="target-kb-input"
                      type="number"
                      min={10}
                      max={20480}
                      step={10}
                      value={targetKB || ''}
                      placeholder="Custom KB (e.g. 150)"
                      onChange={e => {
                        const v = Number(e.target.value);
                        setTargetKB(v > 0 ? v : 0);
                        markDirty();
                      }}
                      className="ie-input"
                      style={{ flex: 1 }}
                    />
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontWeight: 600 }}>KB</span>
                  </div>
                </div>

                {/* Output Format */}
                <div className="setting-group">
                  <label>Output Format</label>
                  <div className="ie-btn-grid-3">
                    {[
                      { id: 'original',   label: 'Original' },
                      { id: 'image/jpeg', label: 'JPG (Small)' },
                      { id: 'image/webp', label: 'WebP (Smallest)' },
                    ].map(f => (
                      <button
                        key={f.id}
                        type="button"
                        className={`ie-chip-btn ${outputFormat === f.id ? 'active' : ''}`}
                        onClick={() => { setOutputFormat(f.id as OutputFormat); markDirty(); }}
                      >
                        {f.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Max Resolution */}
                <div className="setting-group">
                  <label>Max Dimension</label>
                  <div className="ie-btn-grid-4">
                    {MAX_DIM_PRESETS.map(d => (
                      <button
                        key={d.label}
                        type="button"
                        className={`ie-chip-btn ${maxDim === d.px ? 'active' : ''}`}
                        onClick={() => { setMaxDim(d.px); markDirty(); }}
                      >
                        {d.label}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Quality Slider */}
            <div className="setting-group">
              <label htmlFor="quality-slider">
                Quality: <strong style={{ color: 'var(--primary)' }}>{Math.round((mode === 'image' ? quality : pdfQuality) * 100)}%</strong>
              </label>
              <input
                id="quality-slider"
                type="range" min="0.1" max="1" step="0.05"
                value={mode === 'image' ? quality : pdfQuality}
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (mode === 'image') setQuality(val);
                  else setPdfQuality(val);
                  markDirty();
                }}
                className="range-input"
                aria-label={`Compression quality: ${Math.round((mode === 'image' ? quality : pdfQuality) * 100)}%`}
              />
            </div>

            {settingsDirty && queue.length > 0 && (
              <button
                type="button"
                className="download-btn"
                onClick={recompressAll}
                style={{ padding: '0.65rem 1rem', fontSize: '0.875rem' }}
              >
                <RefreshCw size={15} /> Apply New Settings &amp; Re-compress
              </button>
            )}
          </div>

          <div
            className={`upload-area ${isDragging ? 'dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={e => { e.preventDefault(); setIsDragging(false); handleFiles(e.dataTransfer.files); }}
            onClick={() => fileInputRef.current?.click()}
            role="button" tabIndex={0} aria-label={`Upload ${mode === 'image' ? 'images' : 'PDF files'} to compress`}
            onKeyDown={e => e.key === 'Enter' && fileInputRef.current?.click()}
          >
            <Upload size={44} className="upload-icon" aria-hidden="true" />
            <div>
              <p><strong style={{ color: 'var(--text-main)' }}>Drag & Drop {mode === 'image' ? 'Images' : 'PDFs'}</strong> or click to browse</p>
              <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                Supports bulk selection — 100% local in your browser
              </p>
            </div>
            <input
              type="file" multiple ref={fileInputRef} style={{ display: 'none' }}
              onChange={e => e.target.files && handleFiles(e.target.files)}
              accept={mode === 'image' ? 'image/*' : 'application/pdf'}
              aria-label={`Select ${mode === 'image' ? 'image' : 'PDF'} files`}
            />
          </div>

          {queue.length > 0 && (
            <div className="file-list">
              <div className="file-list-header">
                <h3>Queue ({queue.length})</h3>
                <button
                  className="btn-primary"
                  onClick={downloadAll}
                  style={{ padding: '0.5rem 1rem', fontSize: '0.875rem' }}
                  aria-label="Download all compressed files"
                >
                  <Download size={15} aria-hidden="true" />
                  {queue.filter(i => i.status === 'done').length > 1 ? 'Download All (ZIP)' : 'Download'}
                </button>
              </div>

              {queue.map(item => {
                const savings = item.compressedSize
                  ? Math.round((1 - item.compressedSize / item.originalSize) * 100)
                  : null;
                return (
                  <div
                    key={item.id}
                    className="file-item"
                    style={{ cursor: item.status === 'done' ? 'pointer' : 'default', borderColor: selectedPreview?.id === item.id ? 'var(--primary)' : undefined }}
                    onClick={() => item.status === 'done' && setSelectedPreview(item)}
                    role={item.status === 'done' ? 'button' : undefined}
                    aria-label={item.status === 'done' ? `Preview ${item.file.name}` : item.file.name}
                  >
                    <div className="file-info">
                      {item.status === 'processing'
                        ? <Loader2 className="spinner" size={18} color="var(--primary)" aria-label="Processing" />
                        : item.status === 'done'
                          ? <CheckCircle2 size={18} color="var(--success)" aria-label="Done" />
                          : item.status === 'error'
                            ? <X size={18} color="var(--error)" aria-label="Error" />
                            : <Upload size={18} color="var(--text-muted)" aria-label="Pending" />
                      }
                      <div className="file-details">
                        <h4>{item.outputName || item.file.name}</h4>
                        <p>
                          {formatSize(item.originalSize)}
                          {item.compressedSize !== undefined && (
                            <> → <span style={{ color: 'var(--success)' }}>{formatSize(item.compressedSize)}</span>
                              {savings !== null && savings > 0 && <> <span style={{ color: 'var(--accent)', fontWeight: 700 }}>({savings}% saved)</span></>}
                            </>
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="action-btns">
                      {item.status === 'done' && (
                        <button
                          className="btn-icon"
                          onClick={e => { e.stopPropagation(); downloadOne(item); }}
                          aria-label={`Download ${item.outputName || item.file.name}`}
                          title="Download"
                        >
                          <Download size={15} />
                        </button>
                      )}
                      {item.status === 'done' && mode === 'image' && (
                        <button
                          className="btn-icon"
                          onClick={e => { e.stopPropagation(); setPreviewItem(item); }}
                          aria-label={`Compare original vs compressed for ${item.file.name}`}
                          title="Compare"
                        >
                          <Eye size={15} />
                        </button>
                      )}
                      <button
                        className="btn-icon"
                        onClick={e => { e.stopPropagation(); setQueue(q => q.filter(i => i.id !== item.id)); if (selectedPreview?.id === item.id) setSelectedPreview(null); }}
                        aria-label={`Remove ${item.file.name}`}
                        title="Remove"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Preview Panel ── */}
        <div className="tool-preview-panel">
          <div className="preview-panel-header">
            <h4>Preview</h4>
            {selectedPreview && (
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Click a file to preview</span>
            )}
          </div>
          <div className="preview-panel-body" style={{ height: 480 }}>
            {selectedPreview ? (
              mode === 'image' && selectedPreview.previewUrl ? (
                <img
                  src={selectedPreview.previewUrl}
                  alt={`Compressed preview of ${selectedPreview.file.name}`}
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', padding: '1rem' }}
                />
              ) : mode === 'pdf' && selectedPreview.previewUrl ? (
                <iframe
                  src={selectedPreview.previewUrl}
                  title={`Compressed PDF preview: ${selectedPreview.file.name}`}
                  style={{ width: '100%', height: '100%', border: 'none' }}
                />
              ) : null
            ) : (
              <div className="preview-empty" role="img" aria-label="No file selected for preview">
                <Upload size={48} aria-hidden="true" />
                <p>Upload and reduce a file to see preview</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Compare Modal */}
      {previewItem && (
        <div className="modal-overlay" onClick={() => setPreviewItem(null)} role="dialog" aria-modal="true" aria-label={`Compare: ${previewItem.file.name}`}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Before / After: {previewItem.file.name}</h3>
              <button className="btn-icon" onClick={() => setPreviewItem(null)} aria-label="Close comparison">
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: '1rem' }}>
              <div className="slider-container" style={{ borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                <ReactCompareSlider
                  itemOne={<ReactCompareSliderImage src={previewItem.originalUrl!} alt="Original" />}
                  itemTwo={<ReactCompareSliderImage src={previewItem.previewUrl!} alt="Compressed" />}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem', fontSize: '0.875rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Original: {formatSize(previewItem.originalSize)}</span>
                <span style={{ color: 'var(--success)', fontWeight: 700 }}>Reduced: {previewItem.compressedSize ? formatSize(previewItem.compressedSize) : '—'}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
