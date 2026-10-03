/**
 * Deterministic question importers (no AI involved).
 *
 * Supported formats — documented in docs/question-import.md:
 *   • JSON  — `{ "questions": [ { ...friendly row... } ] }` or a bare array
 *   • CSV   — header row with the columns listed in CSV_COLUMNS
 *   • TEXT  — key/value blocks separated by a line containing only `---`
 *
 * Every parser produces ImportItems that carry a human-readable reference
 * (row / block line number) so admins can locate errors in their source file.
 */
import { DOMAINS } from '../constants.js';
import { MAX_OPTIONS, questionInputSchema, type QuestionData } from '../schemas/question.js';
import { parseCsv } from './csv.js';

export type ImportFormat = 'json' | 'csv' | 'text';

export interface ImportItem {
  /** e.g. "Row 4", "Question 3 (line 12)" */
  ref: string;
  question?: QuestionData;
  errors: string[];
}

/** The domains an import may reference (the server passes the current database list). */
export type ImportDomain = { slug: string; name: string };

export interface ImportParseResult {
  format: ImportFormat;
  items: ImportItem[];
  /** File-level problems (e.g. malformed JSON, missing CSV columns). */
  fatalErrors: string[];
}

/** Loose, author-friendly shape accepted by all three importers. */
export interface FriendlyQuestionRow {
  domain?: unknown;
  section?: unknown;
  type?: unknown;
  difficulty?: unknown;
  marks?: unknown;
  negativeMarks?: unknown;
  question?: unknown;
  text?: unknown;
  options?: unknown;
  answer?: unknown;
  explanation?: unknown;
  externalId?: unknown;
  id?: unknown;
}

export const CSV_COLUMNS = [
  'external_id',
  'domain',
  'section',
  'type',
  'difficulty',
  'marks',
  'negative_marks',
  'question',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'option_e',
  'option_f',
  'answer',
  'explanation',
] as const;

const REQUIRED_CSV_COLUMNS = ['domain', 'section', 'type', 'question'] as const;
const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

const normKey = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolveDomainSlug(value: unknown, domains: readonly ImportDomain[] = DOMAINS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const key = normKey(value);
  if (!key) return undefined;
  return domains.find((d) => normKey(d.slug) === key || normKey(d.name) === key)?.slug;
}

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
};

/** Convert a friendly row into a validated QuestionData or a list of errors. */
export function normalizeFriendlyRow(row: FriendlyQuestionRow, domains: readonly ImportDomain[] = DOMAINS): { question?: QuestionData; errors: string[] } {
  const errors: string[] = [];

  const domainRaw = str(row.domain);
  const domainSlug = resolveDomainSlug(domainRaw, domains);
  if (!domainRaw) errors.push('Domain is required');
  else if (!domainSlug) errors.push(`Unknown domain "${domainRaw}" (use one of: ${domains.map((d) => d.name).join(', ')})`);

  const sectionRaw = str(row.section);
  const section = sectionRaw?.replace(/^section\s*/i, '').toUpperCase();

  const typeRaw = str(row.type)?.toUpperCase();
  const type = typeRaw === 'CODE' ? 'CODING' : typeRaw;

  const difficulty = str(row.difficulty)?.toUpperCase();

  const options: string[] = Array.isArray(row.options)
    ? row.options.map((o) => (typeof o === 'string' ? o.trim() : String(o ?? '').trim())).filter((o) => o !== '')
    : [];

  if (options.length > MAX_OPTIONS) errors.push(`At most ${MAX_OPTIONS} options are supported`);

  let correctIndex = -1;
  const answerRaw = str(row.answer);
  if (type === 'MCQ') {
    if (!answerRaw) {
      errors.push('Answer is required for MCQs (option letter, 1-based number, or exact option text)');
    } else {
      const letter = answerRaw.toUpperCase().replace(/^OPTION\s*/, '').replace(/[).]$/, '');
      if (/^[A-F]$/.test(letter)) correctIndex = OPTION_LETTERS.indexOf(letter as (typeof OPTION_LETTERS)[number]);
      else if (/^[1-6]$/.test(letter)) correctIndex = Number(letter) - 1;
      else correctIndex = options.findIndex((o) => o.toLowerCase() === answerRaw.toLowerCase());
      if (correctIndex < 0 || correctIndex >= options.length) {
        errors.push(`Answer "${answerRaw}" does not match any option`);
        correctIndex = -1;
      }
    }
  } else if (type === 'CODING' && answerRaw) {
    errors.push('Coding questions must not have an MCQ answer key');
  }

  const candidate = {
    domainSlug: domainSlug ?? '',
    section: section ?? '',
    type: type ?? '',
    text: str(row.question) ?? str(row.text) ?? '',
    options: options.map((text, i) => ({ text, isCorrect: i === correctIndex })),
    marks: str(row.marks) ?? 1,
    negativeMarks: str(row.negativeMarks) ?? 0,
    difficulty: difficulty ?? 'MEDIUM',
    explanation: str(row.explanation) ?? null,
    isActive: true,
    externalRef: str(row.externalId) ?? str(row.id) ?? null,
  };

  const parsed = questionInputSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path.join('.');
      // Avoid repeating the domain error already reported above.
      if (field === 'domainSlug' && domainRaw !== undefined && !domainSlug) continue;
      if (field === 'domainSlug' && !domainRaw) continue;
      const message = `${field ? `${field}: ` : ''}${issue.message}`;
      if (!errors.includes(message)) errors.push(message);
    }
  }
  if (errors.length > 0 || !parsed.success) return { errors };
  return { question: parsed.data, errors };
}

// ───────────────────────── JSON ─────────────────────────

export function parseQuestionsJson(input: string, domains: readonly ImportDomain[] = DOMAINS): ImportParseResult {
  const result: ImportParseResult = { format: 'json', items: [], fatalErrors: [] };
  let data: unknown;
  try {
    data = JSON.parse(input);
  } catch (e) {
    result.fatalErrors.push(`Invalid JSON: ${(e as Error).message}`);
    return result;
  }
  const list = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { questions?: unknown }).questions)
      ? (data as { questions: unknown[] }).questions
      : null;
  if (!list) {
    result.fatalErrors.push('Expected an array of questions or an object with a "questions" array');
    return result;
  }
  list.forEach((raw, i) => {
    const ref = `Question ${i + 1}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      result.items.push({ ref, errors: ['Each question must be a JSON object'] });
      return;
    }
    const r = raw as Record<string, unknown>;
    const { question, errors } = normalizeFriendlyRow({
      ...r,
      negativeMarks: r.negativeMarks ?? r.negative_marks,
      externalId: r.externalId ?? r.external_id ?? r.id,
    }, domains);
    result.items.push({ ref, question, errors });
  });
  return result;
}

// ───────────────────────── CSV ─────────────────────────

export function parseQuestionsCsv(input: string, domains: readonly ImportDomain[] = DOMAINS): ImportParseResult {
  const result: ImportParseResult = { format: 'csv', items: [], fatalErrors: [] };
  let rows: string[][];
  try {
    rows = parseCsv(input);
  } catch (e) {
    result.fatalErrors.push((e as Error).message);
    return result;
  }
  const nonEmpty = rows.map((cells, idx) => ({ cells, line: idx + 1 })).filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (nonEmpty.length === 0) {
    result.fatalErrors.push('The CSV file is empty');
    return result;
  }
  const header = nonEmpty[0]!.cells.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    result.fatalErrors.push(`Missing required column(s): ${missing.join(', ')}. Expected header: ${CSV_COLUMNS.join(',')}`);
    return result;
  }
  const col = (cells: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? cells[i] : undefined;
  };
  for (const { cells, line } of nonEmpty.slice(1)) {
    const ref = `Row ${line}`;
    if (cells.length > header.length && cells.slice(header.length).some((c) => c.trim() !== '')) {
      result.items.push({ ref, errors: [`Row has ${cells.length} columns but the header has ${header.length}`] });
      continue;
    }
    const options = OPTION_LETTERS.map((l) => col(cells, `option_${l.toLowerCase()}`)).filter(
      (o): o is string => o !== undefined && o.trim() !== '',
    );
    const { question, errors } = normalizeFriendlyRow({
      externalId: col(cells, 'external_id'),
      domain: col(cells, 'domain'),
      section: col(cells, 'section'),
      type: col(cells, 'type'),
      difficulty: col(cells, 'difficulty'),
      marks: col(cells, 'marks'),
      negativeMarks: col(cells, 'negative_marks'),
      question: col(cells, 'question'),
      options,
      answer: col(cells, 'answer'),
      explanation: col(cells, 'explanation'),
    }, domains);
    result.items.push({ ref, question, errors });
  }
  return result;
}

// ───────────────────────── TEXT ─────────────────────────

const TEXT_KEYS: Record<string, keyof FriendlyQuestionRow> = {
  id: 'externalId',
  externalid: 'externalId',
  domain: 'domain',
  section: 'section',
  type: 'type',
  difficulty: 'difficulty',
  marks: 'marks',
  negative: 'negativeMarks',
  negativemarks: 'negativeMarks',
  q: 'question',
  question: 'question',
  answer: 'answer',
  explanation: 'explanation',
};

const KEY_LINE = /^([A-Za-z][A-Za-z ]{0,20}):\s?(.*)$/;
const OPTION_LINE = /^([A-Fa-f])[).]\s+(.*)$/;

export function parseQuestionsText(input: string, domains: readonly ImportDomain[] = DOMAINS): ImportParseResult {
  const result: ImportParseResult = { format: 'text', items: [], fatalErrors: [] };
  const lines = input.replace(/\r\n?/g, '\n').split('\n');

  type Block = { startLine: number; lines: { text: string; line: number }[] };
  const blocks: Block[] = [];
  let current: Block | null = null;
  lines.forEach((text, idx) => {
    const line = idx + 1;
    if (/^\s*---+\s*$/.test(text)) {
      current = null;
      return;
    }
    if (/^\s*#/.test(text) && !current) return; // comments between blocks
    if (!current) {
      if (text.trim() === '') return;
      current = { startLine: line, lines: [] };
      blocks.push(current);
    }
    current.lines.push({ text, line });
  });

  blocks.forEach((block, i) => {
    const ref = `Question ${i + 1} (line ${block.startLine})`;
    const row: Record<string, unknown> = {};
    const options: string[] = [];
    const errors: string[] = [];
    // Field that multi-line continuation text is appended to.
    let continuing: { kind: 'field'; key: 'question' | 'explanation' } | { kind: 'option'; index: number } | null = null;

    for (const { text, line } of block.lines) {
      const opt = OPTION_LINE.exec(text);
      const key = KEY_LINE.exec(text);
      const mappedKey = key ? TEXT_KEYS[normKey(key[1]!)] : undefined;
      if (opt) {
        const expected = OPTION_LETTERS[options.length];
        if (opt[1]!.toUpperCase() !== expected) {
          errors.push(`Line ${line}: expected option ${expected ?? '(none — too many options)'} but found ${opt[1]!.toUpperCase()}`);
        }
        options.push(opt[2]!.trim());
        continuing = { kind: 'option', index: options.length - 1 };
      } else if (key && mappedKey) {
        if (row[mappedKey] !== undefined) errors.push(`Line ${line}: "${key[1]}" appears more than once`);
        row[mappedKey] = key[2]!.trim();
        continuing = mappedKey === 'question' || mappedKey === 'explanation' ? { kind: 'field', key: mappedKey } : null;
      } else if (continuing) {
        if (continuing.kind === 'option') {
          options[continuing.index] = `${options[continuing.index]}\n${text}`.trimEnd();
        } else {
          const prev = (row[continuing.key] as string | undefined) ?? '';
          row[continuing.key] = prev === '' ? text : `${prev}\n${text}`;
        }
      } else if (text.trim() !== '' && !/^\s*#/.test(text)) {
        errors.push(`Line ${line}: unrecognised line "${text.slice(0, 40)}"`);
      }
    }
    if (typeof row.question === 'string') row.question = row.question.trim();
    if (typeof row.explanation === 'string') row.explanation = row.explanation.trim();
    const normalized = normalizeFriendlyRow({ ...row, options }, domains);
    const allErrors = [...errors, ...normalized.errors];
    result.items.push({ ref, question: allErrors.length ? undefined : normalized.question, errors: allErrors });
  });

  if (blocks.length === 0) result.fatalErrors.push('No questions found');
  return result;
}

export function parseQuestionImport(format: ImportFormat, content: string, domains: readonly ImportDomain[] = DOMAINS): ImportParseResult {
  switch (format) {
    case 'json':
      return parseQuestionsJson(content, domains);
    case 'csv':
      return parseQuestionsCsv(content, domains);
    case 'text':
      return parseQuestionsText(content, domains);
  }
}
