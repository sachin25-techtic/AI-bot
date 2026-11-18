import { BadRequestException } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { extractPdfPages, normalizeWhitespace, PageText } from './pdf-text';

export interface WebDocument {
  title: string;
  /** 'pdf' if the URL pointed at a PDF file, which keeps its page numbers. */
  type: 'web' | 'pdf';
  pages: PageText[];
}

const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;

/** Elements that hold readable text. */
const TEXT_BLOCKS =
  'h1, h2, h3, h4, h5, h6, p, li, pre, blockquote, td, th, dt, dd, figcaption';

/** Page furniture that isn't content. */
const NOISE =
  'script, style, noscript, template, svg, iframe, nav, header, footer, aside, form, button';

/**
 * Downloads a web page and extracts its readable text.
 *
 * A web page is mostly NOT content: menus, cookie banners, footers, scripts.
 * We strip those, prefer the <article> or <main> element, and keep the text
 * of each paragraph / heading / list item separated by blank lines so the
 * chunker can split at paragraph boundaries.
 */
export async function extractWebPage(url: string): Promise<WebDocument> {
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; local-rag-demo/1.0)',
        Accept: 'text/html,application/pdf;q=0.9,text/plain;q=0.8',
      },
    });
  } catch {
    throw new BadRequestException(
      `Couldn't download ${url}. Check the address and your internet connection.`,
    );
  }
  if (!res.ok) {
    throw new BadRequestException(
      `Couldn't download ${url}: the site answered ${res.status} ${res.statusText}.`,
    );
  }

  const declaredSize = Number(res.headers.get('content-length') ?? 0);
  if (declaredSize > MAX_BYTES) {
    throw new BadRequestException('That page is too large (max 25 MB).');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) {
    throw new BadRequestException('That page is too large (max 25 MB).');
  }

  const contentType = res.headers.get('content-type') ?? '';
  const finalUrl = res.url || url;

  // A link straight to a PDF: treat it like an uploaded PDF (keeps page numbers).
  if (
    contentType.includes('application/pdf') ||
    buffer.subarray(0, 4).toString() === '%PDF'
  ) {
    return {
      title: fileNameFromUrl(finalUrl),
      type: 'pdf',
      pages: await extractPdfPages(buffer),
    };
  }

  if (contentType.includes('text/plain')) {
    const text = normalizeWhitespace(buffer.toString('utf8'));
    return {
      title: fileNameFromUrl(finalUrl),
      type: 'web',
      pages: text ? [{ page: null, text }] : [],
    };
  }

  if (!contentType.includes('html')) {
    throw new BadRequestException(
      `Unsupported content type "${contentType}". Use a web page, PDF or plain-text URL.`,
    );
  }

  return { type: 'web', ...htmlToText(buffer.toString('utf8'), finalUrl) };
}

export function htmlToText(
  html: string,
  url: string,
): { title: string; pages: PageText[] } {
  const $ = cheerio.load(html);
  const title = (
    $('meta[property="og:title"]').attr('content') ||
    $('title').first().text() ||
    $('h1').first().text() ||
    new URL(url).hostname
  )
    .replace(/\s+/g, ' ')
    .trim();

  $(NOISE).remove();

  const article = $('article').first();
  const main = $('main').first();
  const root = article.length ? article : main.length ? main : $('body');

  const parts: string[] = [];
  root.find(TEXT_BLOCKS).each((_, el) => {
    const block = $(el);
    // Skip containers of other blocks (e.g. an <li> holding <p>s): the inner
    // blocks are collected on their own, so this avoids duplicate text.
    if (block.find(TEXT_BLOCKS).length > 0) return;
    const text = block.text().replace(/\s+/g, ' ').trim();
    if (text) parts.push(text);
  });

  let text = parts.join('\n\n');
  // Some sites put text straight in <div>s. Fall back to all visible text.
  if (text.length < 200) text = root.text();
  text = normalizeWhitespace(text);

  return { title, pages: text ? [{ page: null, text }] : [] };
}

function fileNameFromUrl(url: string): string {
  const { pathname, hostname } = new URL(url);
  const last = decodeURIComponent(
    pathname.split('/').filter(Boolean).pop() ?? '',
  );
  return last || hostname;
}
