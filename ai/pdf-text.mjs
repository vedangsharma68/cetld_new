const MAX_PAGES = 20;
const MAX_TEXT_CHARS = 120_000;
const DEFAULT_TIMEOUT_MS = 8_000;

// A selectable-text PDF is cheaper and more portable for free text models than
// forwarding a binary PDF. Return null for scans or unsupported documents so
// callers can use their existing document-understanding path.
export async function extractPdfText(bytes, {getDocumentImpl, timeoutMs = DEFAULT_TIMEOUT_MS} = {}) {
  let task;
  let timer;
  try {
    // Keep PDF.js loading inside this optional path: a missing native canvas
    // build must never take down unrelated Assistant requests at module load.
    if (!getDocumentImpl) {
      await import('@napi-rs/canvas');
      // Vercel's file tracer does not retain PDF.js's implicit worker file.
      // The worker module registers its in-process handler for Node parsing.
      await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      ({getDocument: getDocumentImpl} = await import('pdfjs-dist/legacy/build/pdf.mjs'));
    }
    task = getDocumentImpl({data: Uint8Array.from(bytes), useSystemFonts: true, disableFontFace: true});
    const parse = (async () => {
      const document = await task.promise;
      if (document.numPages < 1 || document.numPages > MAX_PAGES) return null;
      const pages = [];
      let length = 0;
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number);
        const content = await page.getTextContent();
        const text = content.items.map(item => typeof item.str === 'string' ? `${item.str}${item.hasEOL ? '\n' : ''}` : '').join('').trim();
        page.cleanup();
        length += text.length;
        if (length > MAX_TEXT_CHARS) return null;
        pages.push(`Page ${number} of ${document.numPages}\n${text}`);
      }
      return pages.join('\n\n');
    })();
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('PDF text parsing timed out')), timeoutMs);
    });
    const result = await Promise.race([parse, deadline]);
    if (!result) return null;
    return result.replace(/\s/g, '').length >= 80 ? result : null;
  } catch (error) {
    console.warn('Invoice PDF text unavailable:', error instanceof Error ? error.message : 'unknown error');
    return null;
  } finally {
    clearTimeout(timer);
    // PDF.js may itself be stalled; do not let worker cleanup extend the bound.
    if (task) void task.destroy().catch(() => {});
  }
}
