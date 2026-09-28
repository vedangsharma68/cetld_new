import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PAGES = 20;
const MAX_TEXT_CHARS = 120_000;

// A selectable-text PDF is cheaper and more portable for free text models than
// forwarding a binary PDF. Return null for scans or unsupported documents so
// callers can use their existing document-understanding path.
export async function extractPdfText(bytes) {
  let task;
  try {
    task = getDocument({data: Uint8Array.from(bytes), useSystemFonts: true, disableFontFace: true});
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
    const result = pages.join('\n\n');
    return result.replace(/\s/g, '').length >= 80 ? result : null;
  } catch {
    return null;
  } finally {
    if (task) await task.destroy().catch(() => {});
  }
}
