import { Link } from 'react-router-dom';
import {
  Wand2, Minimize2, UserSquare2, Repeat, LayoutGrid, Droplets, ShieldOff,
  ChevronRight, ShieldCheck
} from 'lucide-react';

interface ImageToolCard {
  id: string;
  title: string;
  description: string;
  path: string;
  icon: React.ReactNode;
  color: string;
  bg: string;
  badge?: string;
}

const IMAGE_TOOLS_LIST: ImageToolCard[] = [
  {
    id: 'image-editor',
    title: 'Image Editor & Document Scanner',
    description: 'Auto-crop & 4-corner flatten documents, Scanned Copy B&W, AI/Wand background removal, draw, blur & resize.',
    path: '/image-editor',
    icon: <Wand2 size={22} />,
    color: '#EC4899',
    bg: 'rgba(236,72,153,0.12)',
    badge: 'Popular',
  },
  {
    id: 'reduce-image-size',
    title: 'Image Size Reducer',
    description: 'Shrink JPG, PNG & WebP files to an exact target KB/MB with responsive Before/After comparison and bulk ZIP export.',
    path: '/reduce-image-size',
    icon: <Minimize2 size={22} />,
    color: '#F97316',
    bg: 'rgba(249,115,22,0.12)',
    badge: 'Popular',
  },
  {
    id: 'id-photo',
    title: 'ID / Passport Photo Maker',
    description: 'Create 1×1, 2×2, or Passport photos with AI/Wand BG removal, White/Blue/Red backdrop & printable 4R/A4 PDF sheets.',
    path: '/id-photo',
    icon: <UserSquare2 size={22} />,
    color: '#3B82F6',
    bg: 'rgba(59,130,246,0.12)',
    badge: 'New',
  },
  {
    id: 'image-converter',
    title: 'Bulk Image Format Converter',
    description: 'Batch convert PNG, JPG, WebP & BMP images with transparency fill color, quality control, and ZIP download.',
    path: '/image-converter',
    icon: <Repeat size={22} />,
    color: '#10B981',
    bg: 'rgba(16,185,129,0.12)',
    badge: 'New',
  },
  {
    id: 'image-collage',
    title: 'Image Stitcher & Collage',
    description: 'Combine Front + Back of IDs or multiple photos side-by-side, stacked, or in 2×2/3×3 grids and export as Image or PDF.',
    path: '/image-collage',
    icon: <LayoutGrid size={22} />,
    color: '#8B5CF6',
    bg: 'rgba(139,92,246,0.12)',
    badge: 'New',
  },
  {
    id: 'image-watermark',
    title: 'Bulk Image Watermarker',
    description: 'Stamp custom text or logo watermarks across multiple photos at once (diagonal, tiled, or corner) with ZIP export.',
    path: '/image-watermark',
    icon: <Droplets size={22} />,
    color: '#06B6D4',
    bg: 'rgba(6,182,212,0.12)',
    badge: 'New',
  },
  {
    id: 'exif-stripper',
    title: 'EXIF & Metadata Stripper',
    description: 'Inspect hidden camera EXIF & GPS location coordinates and strip all metadata privately before sharing photos online.',
    path: '/exif-stripper',
    icon: <ShieldOff size={22} />,
    color: '#EF4444',
    bg: 'rgba(239,68,68,0.12)',
    badge: 'New',
  },
];

export default function ImageToolsHub() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      <div
        style={{
          background: 'var(--surface-1)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius)',
          padding: '1.25rem 1.5rem',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: '0.75rem',
        }}
      >
        <div>
          <h2 style={{ fontSize: '1.15rem', marginBottom: '0.25rem' }}>All Image Tools</h2>
          <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', margin: 0 }}>
            Edit, scan, compress, convert, stitch, watermark, and sanitize images right in your browser.
          </p>
        </div>
        <span className="tag-private" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
          <ShieldCheck size={13} /> 100% Client-Side Privacy
        </span>
      </div>

      <div className="tool-grid">
        {IMAGE_TOOLS_LIST.map(tool => (
          <Link key={tool.id} to={tool.path} className="tool-card">
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem' }}>
              <div className="tool-card-icon" style={{ background: tool.bg, color: tool.color }}>
                {tool.icon}
              </div>
              {tool.badge && <span className="tag-new">{tool.badge}</span>}
            </div>
            <div className="tool-card-body">
              <h3>{tool.title}</h3>
              <p>{tool.description}</p>
            </div>
            <div className="tool-card-footer">
              <span className="tag-private">Local</span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)' }}>
                Open <ChevronRight size={15} />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
