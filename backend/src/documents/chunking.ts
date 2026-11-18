/**
 * Step 3a of RAG: split text into chunks before embedding.
 *
 * Why chunk at all?
 *  - Embedding models have an input limit.
 *  - A small, focused chunk gives a more precise vector than a whole page.
 *  - We can only fit a few chunks into the LLM's prompt.
 *
 * Why overlap? A sentence that falls on a chunk boundary still appears whole
 * in at least one chunk.
 *
 * Sizes are in characters to keep things simple (~4 chars ≈ 1 token).
 */
export function chunkText(
  text: string,
  chunkSize = 1000,
  overlap = 200,
): string[] {
  if (text.length <= chunkSize) return text ? [text] : [];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);

    // Prefer to cut at a paragraph, sentence or word break near the end.
    if (end < text.length) {
      const window = text.slice(start, end);
      const breakAt = Math.max(
        window.lastIndexOf('\n\n'),
        window.lastIndexOf('. '),
        window.lastIndexOf('\n'),
      );
      if (breakAt > chunkSize * 0.5) {
        end = start + breakAt + 1;
      } else {
        const space = window.lastIndexOf(' ');
        if (space > chunkSize * 0.5) end = start + space;
      }
    }

    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;

    // Step back by `overlap`, then move forward to the start of a sentence
    // (or at least a word) so the next chunk doesn't begin mid-sentence.
    let next = Math.max(end - overlap, start + 1);
    const overlapText = text.slice(next, end);
    const sentenceBreak = /[.!?]\s+|\n+/.exec(overlapText);
    if (sentenceBreak) {
      next += sentenceBreak.index + sentenceBreak[0].length;
    } else {
      const space = overlapText.indexOf(' ');
      if (space !== -1) next += space + 1;
    }
    start = next;
  }

  return chunks;
}
