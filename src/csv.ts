/**
 * A small, dependency-free CSV parser: a linear character-by-character state machine
 * (no backtracking regex over the whole input), so a hostile file cannot cause a ReDoS.
 * Supports quoted fields, embedded commas/newlines/quotes ("" escape), and CRLF or LF.
 */
export function parseCsvRows(text: string, maxFieldLen = 10_000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;
  const pushField = () => {
    if (field.length > maxFieldLen) field = field.slice(0, maxFieldLen);
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < n) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ',') {
      pushField();
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/row (file may or may not end with a newline).
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop a single fully-empty trailing row (common with a trailing newline).
  while (rows.length && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }
  return rows;
}

export type ColumnType = 'string' | 'number' | 'boolean';

export interface ParsedCsv {
  columns: string[];
  types: ColumnType[];
  rows: Record<string, string | number | boolean | null>[];
}

const NUM_RE = /^-?\d+(\.\d+)?$/;
const BOOL_VALUES = new Set(['true', 'false']);

function inferType(values: string[]): ColumnType {
  let sawNumber = false;
  let sawBool = false;
  let sawAny = false;
  for (const v of values) {
    if (v === '') continue;
    sawAny = true;
    if (NUM_RE.test(v)) {
      sawNumber = true;
    } else if (BOOL_VALUES.has(v.toLowerCase())) {
      sawBool = true;
    } else {
      return 'string';
    }
  }
  if (!sawAny) return 'string';
  if (sawNumber && !sawBool) return 'number';
  if (sawBool && !sawNumber) return 'boolean';
  return 'string';
}

function cast(type: ColumnType, v: string): string | number | boolean | null {
  if (v === '') return null;
  if (type === 'number') return Number(v);
  if (type === 'boolean') return v.toLowerCase() === 'true';
  return v;
}

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
}

export function parseCsv(
  text: string,
  limits: CsvLimits,
): { ok: true; data: ParsedCsv } | { ok: false; error: string } {
  const raw = parseCsvRows(text);
  if (raw.length === 0) return { ok: false, error: 'CSV is empty' };
  const header = raw[0]!.map((h) => h.trim());
  if (header.length === 0 || header.some((h) => h === '')) {
    return { ok: false, error: 'CSV header row must have non-empty column names' };
  }
  if (header.length > limits.maxColumns) {
    return {
      ok: false,
      error: `CSV has ${header.length} columns; the plan allows ${limits.maxColumns}`,
    };
  }
  const seen = new Set<string>();
  for (const h of header) {
    if (seen.has(h)) return { ok: false, error: `duplicate column name "${h}"` };
    seen.add(h);
  }
  const dataRows = raw.slice(1);
  if (dataRows.length > limits.maxRows) {
    return {
      ok: false,
      error: `CSV has ${dataRows.length} rows; the plan allows ${limits.maxRows}`,
    };
  }
  const columnValues: string[][] = header.map(() => []);
  for (const r of dataRows) {
    for (let c = 0; c < header.length; c++) columnValues[c]!.push(r[c] ?? '');
  }
  const types = columnValues.map(inferType);
  const rows = dataRows.map((r) => {
    const obj: Record<string, string | number | boolean | null> = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]!] = cast(types[c]!, r[c] ?? '');
    }
    return obj;
  });
  return { ok: true, data: { columns: header, types, rows } };
}
