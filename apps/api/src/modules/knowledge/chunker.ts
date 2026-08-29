/**
 * Chunking — the second stage of the ingestion pipeline (docs/06 §5).
 *
 * THE INVARIANT THIS FILE KEEPS
 *
 *     chunk.content === sourceText.slice(chunk.charFrom, chunk.charTo)
 *
 * Every chunk is a *slice* of the extracted text, never a reassembly of pieces. That one
 * property is what makes a citation exact: a retrieval result can say "characters 4,210–4,890
 * of the Student Handbook" and a reader can highlight precisely that span in the original. A
 * chunker that joined paragraphs with `'\n\n'` would produce text that no longer appears
 * anywhere in the source, and its offsets would be decoration.
 *
 * HOW IT SPLITS
 *
 * Structure first, budget second — in that order, because a split that follows the document's
 * own shape produces chunks that are *about* one thing, and an embedding of one idea is what
 * makes similarity search work at all. A fixed-width sliding window over characters (the
 * naive approach) cuts through the middle of the sentence that answers the question and
 * embeds half of it with half of the next clause.
 *
 *   1. **Blocks.** The text is parsed into Markdown ATX headings and blank-line-separated
 *      paragraphs, each with its source offsets. Plain text with no headings degrades
 *      gracefully to paragraphs, which is still structure.
 *   2. **Sections.** A heading of level 1 or 2 always starts a new chunk: a chunk that spans
 *      "Fees" and "Discipline" matches neither query well. A level-3-or-deeper heading starts
 *      one only if the chunk in hand is already at least half the target, so a policy written
 *      as twenty `###` sub-clauses does not become twenty forty-token chunks.
 *   3. **Budget.** Within a section, paragraphs are packed until the chunk reaches the target
 *      size, and never past the hard maximum. A single paragraph over the maximum is split on
 *      sentence boundaries, and a single sentence over the maximum on word boundaries — the
 *      last resort, and the only place a chunk boundary can fall mid-sentence.
 *   4. **Overlap.** Each chunk after the first reaches backwards to include the tail of its
 *      predecessor, up to the overlap budget, cut at a sentence boundary. This exists because
 *      the answer to a question is so often the sentence either side of a boundary
 *      ("…refunds are not payable" / "…except where the student withdraws before term").
 *      Overlap is skipped where the chunk begins with a heading: the heading is already the
 *      context, and pulling the previous section's last paragraph in would attribute it to
 *      the wrong section in the citation.
 *
 * TOKEN COUNTS ARE ESTIMATES. There is no tokenizer in this workspace and adding one for
 * chunk budgeting would tie the chunker to one vendor's vocabulary. The estimate below is
 * script-aware and errs long for Bangla, which is the safe direction: a chunk slightly under
 * budget merely retrieves a little less context, while one over the model's limit is silently
 * truncated by the provider — indexing text the chunk does not contain.
 */

export interface ChunkParameters {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

export interface TextChunk {
  seq: number;
  content: string;
  charFrom: number;
  charTo: number;
  tokenCount: number;
  /** "Admissions › Fees › Refunds", or null outside any heading. */
  headingPath: string | null;
}

/**
 * Approximate token count.
 *
 * ~4 characters per token for ASCII is the well-known rule of thumb for BPE vocabularies.
 * Bangla is a different story: the vocabularies these models ship with are trained
 * overwhelmingly on English, so Bangla text is tokenized far more finely — frequently close
 * to one token per character. Counting non-ASCII at one token per 1.2 characters keeps a
 * Bangla circular from quietly producing chunks four times the intended budget.
 */
export function estimateTokens(value: string): number {
  let ascii = 0;
  let other = 0;
  for (const character of value) {
    if (character.codePointAt(0)! < 128) ascii += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + other / 1.2));
}

interface Block {
  kind: 'heading' | 'body';
  /** 1–6 for a heading, 0 for body text. */
  level: number;
  from: number;
  to: number;
}

interface PendingChunk {
  from: number;
  to: number;
  headingPath: string | null;
  startsWithHeading: boolean;
  /**
   * Whether any body text has joined this chunk yet.
   *
   * A heading only ends the chunk in hand if that chunk has something in it *besides*
   * headings. Without this, a document that opens `# Handbook` followed by `## Section One`
   * produces a first chunk containing nothing but the title — eight tokens that embed to
   * nothing useful and will match a query about the title and nothing else.
   */
  hasBody: boolean;
}

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(\S.*)$/;

/**
 * A heading at or above this level always ends the chunk in hand.
 *
 * Level 2 rather than 1 because school documents are routinely written with a single `#`
 * title and every real section as `##`; breaking only on `#` would put the whole handbook in
 * one chunk.
 */
const ALWAYS_BREAK_HEADING_LEVEL = 2;

export function chunkText(sourceText: string, params: ChunkParameters): TextChunk[] {
  const blocks = parseBlocks(sourceText);
  if (blocks.length === 0) return [];

  const chunks: TextChunk[] = [];
  /**
   * Parallel to `chunks`: whether each one opens with its own heading. Read by the overlap
   * pass, and not a field on `TextChunk` because it is scaffolding for this file rather than
   * something a caller or the database has any use for.
   */
  const startsWithHeadingFlags: boolean[] = [];
  const headingStack: { level: number; title: string }[] = [];
  let pending: PendingChunk | null = null;

  const flush = (): void => {
    const current = pending;
    pending = null;
    if (!current) return;
    const span = trimSpan(sourceText, current.from, current.to);
    if (!span) return;
    chunks.push({
      seq: chunks.length,
      content: sourceText.slice(span.from, span.to),
      charFrom: span.from,
      charTo: span.to,
      tokenCount: estimateTokens(sourceText.slice(span.from, span.to)),
      headingPath: current.headingPath,
    });
    startsWithHeadingFlags.push(current.startsWithHeading);
  };

  const add = (block: Block): void => {
    const current = pending;
    if (!current) {
      pending = {
        from: block.from,
        to: block.to,
        headingPath: currentHeadingPath(headingStack),
        startsWithHeading: block.kind === 'heading',
        hasBody: block.kind === 'body',
      };
      return;
    }
    current.to = block.to;
    if (block.kind === 'body') current.hasBody = true;
    // A chunk that opened with a heading and has since taken body text keeps the deepest
    // heading it started under; the path is not re-derived, because a citation should name
    // where the chunk *begins*.
  };

  const pendingTokens = (): number => {
    const current = pending;
    return current ? estimateTokens(sourceText.slice(current.from, current.to)) : 0;
  };

  /**
   * Read through a function rather than touching `pending` directly at the call site.
   *
   * `pending` is only ever assigned inside the closures above, which the control-flow analyser
   * cannot see — so at the call site it narrows the variable to `null` and reading a property
   * off it is a compile error about a type that is `never`. Inside a closure the declared type
   * applies, which is the accurate one.
   */
  const pendingHasBody = (): boolean => pending?.hasBody === true;

  for (const block of blocks) {
    const blockTokens = estimateTokens(sourceText.slice(block.from, block.to));

    if (block.kind === 'heading') {
      // The stack is updated BEFORE the heading joins a chunk, so a chunk that starts with a
      // heading records that heading in its own path rather than its predecessor's.
      while (headingStack.length > 0 && headingStack.at(-1)!.level >= block.level) {
        headingStack.pop();
      }
      headingStack.push({ level: block.level, title: headingTitle(sourceText, block) });

      const alwaysBreak = block.level <= ALWAYS_BREAK_HEADING_LEVEL;
      const bigEnoughToBreak = pendingTokens() >= params.targetTokens / 2;
      // `pendingHasBody`: consecutive headings stay together and merge into the section they
      // introduce, rather than each becoming a chunk of its own title.
      if (pendingHasBody() && (alwaysBreak || bigEnoughToBreak)) flush();
      add(block);
      continue;
    }

    // A block that cannot fit in any chunk is split on its own terms, so the split points are
    // sentence boundaries rather than wherever the previous paragraph happened to end.
    if (blockTokens > params.maxTokens) {
      flush();
      for (const piece of splitOversizedBlock(sourceText, block, params.maxTokens)) {
        const span = trimSpan(sourceText, piece.from, piece.to);
        if (!span) continue;
        chunks.push({
          seq: chunks.length,
          content: sourceText.slice(span.from, span.to),
          charFrom: span.from,
          charTo: span.to,
          tokenCount: estimateTokens(sourceText.slice(span.from, span.to)),
          headingPath: currentHeadingPath(headingStack),
        });
        startsWithHeadingFlags.push(false);
      }
      continue;
    }

    if (pending && pendingTokens() + blockTokens > params.maxTokens) flush();
    add(block);
    if (pendingTokens() >= params.targetTokens) flush();
  }
  flush();

  return applyOverlap(sourceText, chunks, startsWithHeadingFlags, params.overlapTokens);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Structural pass
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Split the text into headings and blank-line-separated paragraphs, carrying source offsets.
 *
 * Offsets are tracked explicitly rather than recovered with `indexOf` afterwards: the same
 * paragraph text can appear twice in a policy document, and `indexOf` would cite the first
 * occurrence for both.
 */
function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let cursor = 0;
  let bodyFrom = -1;
  let bodyTo = -1;

  const closeBody = (): void => {
    if (bodyFrom >= 0 && bodyTo > bodyFrom) {
      blocks.push({ kind: 'body', level: 0, from: bodyFrom, to: bodyTo });
    }
    bodyFrom = -1;
    bodyTo = -1;
  };

  while (cursor <= text.length) {
    const newline = text.indexOf('\n', cursor);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(cursor, lineEnd);

    if (line.trim().length === 0) {
      closeBody();
    } else if (ATX_HEADING.test(line)) {
      closeBody();
      const level = ATX_HEADING.exec(line)![1]!.length;
      blocks.push({ kind: 'heading', level, from: cursor, to: lineEnd });
    } else {
      if (bodyFrom < 0) bodyFrom = cursor;
      bodyTo = lineEnd;
    }

    if (newline === -1) break;
    cursor = newline + 1;
  }
  closeBody();

  return blocks;
}

function headingTitle(text: string, block: Block): string {
  const match = ATX_HEADING.exec(text.slice(block.from, block.to));
  return (match?.[2] ?? '').trim().slice(0, 120);
}

function currentHeadingPath(stack: { level: number; title: string }[]): string | null {
  if (stack.length === 0) return null;
  // Trimmed to the column width; the deepest headings are the informative ones, so the *front*
  // of the trail is what gets dropped.
  const path = stack.map((entry) => entry.title).join(' › ');
  return path.length <= 500 ? path : `… ${path.slice(path.length - 498)}`;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Oversized blocks and sentence boundaries
// ─────────────────────────────────────────────────────────────────────────────────────

interface Span {
  from: number;
  to: number;
}

/**
 * Sentence spans within `[from, to)`.
 *
 * The terminator set includes `।` (U+0964, the Bangla danda), which is the sentence-ending
 * punctuation in Bangla and is absent from every English-only sentence splitter. Without it a
 * Bangla circular is one enormous "sentence" and every split in it falls on a word boundary.
 */
function sentenceSpans(text: string, from: number, to: number): Span[] {
  const spans: Span[] = [];
  let start = from;
  for (let i = from; i < to; i += 1) {
    const character = text[i]!;
    const isTerminator = character === '.' || character === '!' || character === '?' || character === '।';
    if (!isTerminator) continue;
    // Consume the terminator and any trailing whitespace so the next span starts at a word.
    let end = i + 1;
    while (end < to && /\s/.test(text[end]!)) end += 1;
    if (end === i + 1 && end < to) continue; // Mid-token dot: "3.5", "www.example.com".
    if (end > start) spans.push({ from: start, to: end });
    start = end;
    i = end - 1;
  }
  if (start < to) spans.push({ from: start, to });
  return spans;
}

/** Pack sentences up to the budget; split a single over-budget sentence on whitespace. */
function splitOversizedBlock(text: string, block: Block, maxTokens: number): Span[] {
  const out: Span[] = [];
  let current: Span | null = null;

  const push = (): void => {
    if (current) out.push(current);
    current = null;
  };

  for (const sentence of sentenceSpans(text, block.from, block.to)) {
    const sentenceTokens = estimateTokens(text.slice(sentence.from, sentence.to));

    if (sentenceTokens > maxTokens) {
      push();
      out.push(...splitOnWhitespace(text, sentence, maxTokens));
      continue;
    }
    if (current && estimateTokens(text.slice(current.from, sentence.to)) > maxTokens) push();
    current = current ? { from: current.from, to: sentence.to } : { ...sentence };
  }
  push();
  return out;
}

/**
 * The last resort: cut on whitespace inside one sentence that is longer than a whole chunk.
 *
 * This exists for real inputs — a table pasted as one line, a Bangla paragraph with no danda —
 * and it is the only place a chunk boundary can land mid-sentence. It still never lands
 * mid-word, so the chunk text stays readable when it is quoted back as a citation.
 */
function splitOnWhitespace(text: string, span: Span, maxTokens: number): Span[] {
  const out: Span[] = [];
  let start = span.from;
  let lastBreak = -1;
  // The token estimate is accumulated incrementally rather than recomputed from the slice on
  // every character: this function is reached by a table pasted as one line, which can be a
  // megabyte, and re-estimating a growing slice each step is quadratic.
  let ascii = 0;
  let other = 0;

  for (let i = span.from; i < span.to; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 128) ascii += 1;
    else other += 1;
    if (/\s/.test(text[i]!)) lastBreak = i;
    if (Math.ceil(ascii / 4 + other / 1.2) < maxTokens) continue;

    const cut = lastBreak > start ? lastBreak : i + 1;
    out.push({ from: start, to: cut });
    // Whatever was after the break point is re-counted from the next iteration; restarting the
    // tally at the cut keeps the estimate honest rather than carrying the previous piece's.
    start = cut;
    lastBreak = -1;
    ascii = 0;
    other = 0;
    i = cut - 1;
  }
  if (start < span.to) out.push({ from: start, to: span.to });
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Overlap
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Extend each chunk backwards into its predecessor, up to the overlap budget.
 *
 * Because a chunk is defined by its offsets and its content is a slice, overlap is simply a
 * smaller `charFrom` — the slice invariant survives untouched, and a citation that includes
 * overlapped text still points at exactly the characters it quotes.
 */
function applyOverlap(
  sourceText: string,
  chunks: TextChunk[],
  startsWithHeading: boolean[],
  overlapTokens: number,
): TextChunk[] {
  if (overlapTokens <= 0 || chunks.length < 2) return chunks;

  const out: TextChunk[] = [chunks[0]!];
  for (let i = 1; i < chunks.length; i += 1) {
    const chunk = chunks[i]!;
    const previous = chunks[i - 1]!;

    // A chunk that opens with its own heading already carries its context; reaching back would
    // pull the previous section's text under this section's heading in the citation.
    if (startsWithHeading[i] === true) {
      out.push({ ...chunk, seq: i });
      continue;
    }

    const overlapStart = overlapStartOffset(sourceText, previous, overlapTokens);
    if (overlapStart === null || overlapStart >= chunk.charFrom || overlapStart <= previous.charFrom) {
      out.push({ ...chunk, seq: i });
      continue;
    }

    const content = sourceText.slice(overlapStart, chunk.charTo);
    out.push({
      ...chunk,
      seq: i,
      charFrom: overlapStart,
      content,
      tokenCount: estimateTokens(content),
    });
  }
  return out;
}

/** The offset of the earliest sentence in `previous` whose tail fits the overlap budget. */
function overlapStartOffset(
  sourceText: string,
  previous: TextChunk,
  overlapTokens: number,
): number | null {
  const spans = sentenceSpans(sourceText, previous.charFrom, previous.charTo);
  if (spans.length === 0) return null;

  let start: number | null = null;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const candidate = spans[i]!.from;
    if (estimateTokens(sourceText.slice(candidate, previous.charTo)) > overlapTokens) break;
    start = candidate;
  }
  return start;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Boundaries
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Shrink a span past leading and trailing whitespace.
 *
 * Done by moving the offsets rather than by trimming the string, because trimming would break
 * the `content === slice(charFrom, charTo)` invariant this whole file rests on.
 */
function trimSpan(text: string, from: number, to: number): Span | null {
  let start = from;
  let end = to;
  while (start < end && /\s/.test(text[start]!)) start += 1;
  while (end > start && /\s/.test(text[end - 1]!)) end -= 1;
  return end > start ? { from: start, to: end } : null;
}
