/**
 * Minimal RFC 4180 CSV reader/writer (quoted fields, escaped quotes, embedded
 * newlines, CRLF/LF). Kept dependency-free on purpose.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let quotedLine = 0;
  let line = 1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      if (field.trim() !== '') throw new Error(`CSV line ${line}: unexpected quote inside an unquoted field`);
      field = '';
      inQuotes = true;
      quotedLine = line;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
    } else {
      field += ch;
    }
  }
  if (inQuotes) throw new Error(`CSV line ${quotedLine}: unterminated quoted field`);
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Serialise one CSV cell. Values that a spreadsheet would interpret as a
 * formula (=, +, -, @, tab, CR) are prefixed with an apostrophe to prevent
 * CSV/formula injection when admins open exports in Excel/Sheets.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
