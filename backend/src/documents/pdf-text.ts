import { PDFParse } from 'pdf-parse';

export interface PageText {
  page: number; // 1-based page number, used for citations
  text: string;
}

/**
 * Step 2 of RAG: extract the text of each page.
 *
 * We keep text per page (instead of one big string) so every chunk knows
 * which page it came from, and answers can cite "report.pdf, page 4".
 *
 * Note: scanned PDFs are images with no text layer, so this returns nothing
 * for them. Those would need OCR first.
 */
export async function extractPdfPages(data: Buffer): Promise<PageText[]> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return result.pages.map((p) => ({
      page: p.num,
      text: normalizeWhitespace(p.text),
    }));
  } finally {
    await parser.destroy();
  }
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ') // collapse runs of spaces
    .replace(/\n{3,}/g, '\n\n') // at most one blank line
    .trim();
}
