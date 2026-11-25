const express = require('express');
const cors = require('cors');
const multer = require('multer');
const libre = require('libreoffice-convert');
const path = require('path');
const { promisify } = require('util');

// Promisify convertWithOptions so we can pass fileName extension options and soffice args
const libreConvertAsync = promisify(libre.convertWithOptions);

const app = express();
app.use(cors({
  origin: '*',
  allowedHeaders: ['Content-Type', 'x-withoutbg-api-key']
}));

// Health & capability check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    hasWithoutBgKey: Boolean(process.env.WITHOUTBG_API_KEY)
  });
});

// Configure multer for in-memory storage (up to 50MB file size limit)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Reusable document conversion controller with strict input extension validation
async function handleConversion(req, res, outputFormat, allowedInputExts) {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }

  // Sanitize filename to prevent path traversal and reject unexpected formats (e.g. .ps / .eps)
  const safeName = path.basename(req.file.originalname || '').replace(/[^a-zA-Z0-9._\s()-]/g, '_');
  const inputExt = path.extname(safeName).toLowerCase();
  if (!allowedInputExts.includes(inputExt)) {
    return res.status(400).json({
      error: `Unsupported input file type "${inputExt || 'unknown'}". Allowed: ${allowedInputExts.join(', ')}.`
    });
  }

  // Ensure format has no leading dot (e.g. "docx" instead of ".docx")
  const format = outputFormat.replace(/^\./, '');
  const dotExt = `.${format}`;

  try {
    console.log(`Converting ${safeName} to format: ${format}...`);
    
    let convertedBuf;
    
    // Check if we are converting FROM a PDF to a spreadsheet (Excel)
    const isPdfInput = inputExt === '.pdf';
    
    if (isPdfInput && format === 'xlsx') {
      // ─── PDF to Excel: Two-Step Conversion ──────────────────────
      // Step 1: Convert PDF to HTML (Draw layout to HTML page representation)
      console.log('PDF to Excel: Step 1 (PDF -> HTML)...');
      const htmlBuf = await libreConvertAsync(
        req.file.buffer,
        'html',
        undefined,
        { fileName: safeName }
      );

      // Step 2: Convert HTML to XLSX (Calc spreadsheet imports HTML tables)
      console.log('PDF to Excel: Step 2 (HTML -> XLSX)...');
      convertedBuf = await libreConvertAsync(
        htmlBuf,
        'xlsx',
        undefined,
        { fileName: 'data.html' }
      );
    } else {
      // ─── Standard Conversions ───────────────────────────────────
      // Add necessary import filters to force PDF files into correct editor applications
      const sofficeAdditionalArgs = [];
      if (isPdfInput) {
        if (format === 'docx') {
          sofficeAdditionalArgs.push('--infilter=writer_pdf_import');
        } else if (format === 'pptx') {
          sofficeAdditionalArgs.push('--infilter=impress_pdf_import');
        }
      }

      convertedBuf = await libreConvertAsync(
        req.file.buffer,
        format,
        undefined,
        { 
          fileName: safeName,
          sofficeAdditionalArgs: sofficeAdditionalArgs
        }
      );
    }
    
    // Retrieve root filename without the extension
    const baseName = path.parse(safeName).name;
    
    // Choose appropriate Content-Type header based on target format
    let contentType = 'application/octet-stream';
    if (format === 'pdf') {
      contentType = 'application/pdf';
    } else if (format === 'docx') {
      contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    } else if (format === 'pptx') {
      contentType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    } else if (format === 'xlsx') {
      contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}${dotExt}"`);
    res.send(convertedBuf);
    
  } catch (error) {
    console.error(`Conversion to ${format} failed:`, error);
    res.status(500).json({ 
      error: 'Conversion failed. Please try again.',
      details: error.message
    });
  }
}

// ─── Convert TO PDF Endpoints ─────────────────────────────────────
app.post('/api/convert/word-to-pdf', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'pdf', ['.doc', '.docx', '.odt', '.rtf']);
});

app.post('/api/convert/ppt-to-pdf', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'pdf', ['.ppt', '.pptx', '.odp']);
});

app.post('/api/convert/excel-to-pdf', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'pdf', ['.xls', '.xlsx', '.ods', '.csv']);
});

// ─── Convert FROM PDF Endpoints ───────────────────────────────────
app.post('/api/convert/pdf-to-word', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'docx', ['.pdf']);
});

app.post('/api/convert/pdf-to-ppt', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'pptx', ['.pdf']);
});

app.post('/api/convert/pdf-to-excel', upload.single('file'), (req, res) => {
  handleConversion(req, res, 'xlsx', ['.pdf']);
});

// ─── Image Background Removal (withoutBG Cloud API Proxy) ─────────
// ponytail: uses withoutBG REST API directly from Node 20 fetch (avoids Python + 1.5GB ONNX weights on Render 512MB tier)
const ALLOWED_IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/bmp']);
app.post('/api/image/remove-bg', upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No image uploaded.' });
  }
  if (!ALLOWED_IMAGE_MIMES.has(req.file.mimetype)) {
    return res.status(415).json({ error: 'Unsupported image format. Allowed: PNG, JPG, WebP, BMP.' });
  }

  const userKey = String(req.headers['x-withoutbg-api-key'] || '').trim();
  const apiKey = userKey || (process.env.WITHOUTBG_API_KEY || '').trim();

  if (!apiKey) {
    return res.status(400).json({
      error: 'No withoutBG API key configured. Enter your API key below or set WITHOUTBG_API_KEY on the server.',
      code: 'MISSING_API_KEY'
    });
  }

  try {
    const form = new FormData();
    const mimeType = req.file.mimetype || 'image/png';
    const fileName = req.file.originalname || 'image.png';
    form.append('file', new Blob([req.file.buffer], { type: mimeType }), fileName);

    const upstream = await fetch('https://api.withoutbg.com/v1.0/image-without-background', {
      method: 'POST',
      headers: { 'X-API-Key': apiKey },
      body: form
    });

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      let message = `withoutBG API returned HTTP ${upstream.status}.`;
      if (upstream.status === 401 || upstream.status === 403) {
        message = 'Invalid withoutBG API key. Please check your key and try again.';
      } else if (upstream.status === 402 || upstream.status === 429) {
        message = 'withoutBG API credits exhausted or rate limit reached. Try entering your own API key or use Offline Magic Wand.';
      } else if (upstream.status === 413) {
        message = 'Image exceeds withoutBG 20MB file size limit. Resize it first and retry.';
      } else if (upstream.status === 415) {
        message = 'Unsupported image format. Please use PNG, JPG, or WebP.';
      }
      return res.status(upstream.status).json({
        error: message,
        code: upstream.status === 402 || upstream.status === 429 ? 'CREDITS_EXHAUSTED' : 'UPSTREAM_ERROR',
        details: errText.slice(0, 300)
      });
    }

    const contentType = upstream.headers.get('content-type') || '';
    let pngBuffer;
    if (contentType.includes('application/json')) {
      const payload = await upstream.json();
      const b64 = payload.img_without_background_base64 || payload.image_base64;
      if (!b64) {
        return res.status(502).json({ error: 'Unexpected JSON response from withoutBG API.' });
      }
      pngBuffer = Buffer.from(b64, 'base64');
    } else {
      const arrayBuf = await upstream.arrayBuffer();
      pngBuffer = Buffer.from(arrayBuf);
    }

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', 'inline; filename="removed-bg.png"');
    return res.send(pngBuffer);
  } catch (error) {
    console.error('withoutBG proxy error:', error);
    return res.status(502).json({
      error: 'Failed to reach withoutBG API.',
      details: error.message
    });
  }
});

// Server listener
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`PDFMaster conversion server running on http://localhost:${PORT}`);
  console.log('NOTE: LibreOffice must be installed on the system (or container) for conversions to run.');
});
