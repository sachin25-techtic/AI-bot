import mammoth from 'mammoth';
import { normalizeWhitespace, PageText } from './pdf-text';

/**
 * Extracts the text of a Word document (.docx).
 *
 * A .docx file stores paragraphs, not pages: page breaks are decided by Word
 * when it lays the document out on screen. So there are no page numbers to
 * cite, and the whole document comes back as one "page" with page = null.
 * Citations then show just the file name.
 */
export async function extractDocxText(data: Buffer): Promise<PageText[]> {
  const { value } = await mammoth.extractRawText({ buffer: data });
  const text = normalizeWhitespace(value);
  return text ? [{ page: null, text }] : [];
}
