import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows } from '../src/csv.js';

describe('parseCsvRows', () => {
  it('parses a simple CSV', () => {
    expect(parseCsvRows('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with embedded commas and newlines', () => {
    const text = 'name,note\n"Doe, Jane","Hello\nworld"\n';
    expect(parseCsvRows(text)).toEqual([
      ['name', 'note'],
      ['Doe, Jane', 'Hello\nworld'],
    ]);
  });

  it('handles escaped quotes ("")', () => {
    expect(parseCsvRows('a\n"she said ""hi"""\n')).toEqual([['a'], ['she said "hi"']]);
  });

  it('handles CRLF line endings', () => {
    expect(parseCsvRows('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles a file with no trailing newline', () => {
    expect(parseCsvRows('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('does not hang on a large, non-pathological file (linear time check)', () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => `r${i},v${i}`).join('\n');
    const start = Date.now();
    const parsed = parseCsvRows(`a,b\n${rows}\n`);
    expect(Date.now() - start).toBeLessThan(2000);
    expect(parsed).toHaveLength(20_001);
  });
});

describe('parseCsv', () => {
  const limits = { maxRows: 1000, maxColumns: 20 };

  it('parses columns, infers types and casts values', () => {
    const csv = 'name,age,active\nAda,36,true\nAlan,41,false\n';
    const r = parseCsv(csv, limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.columns).toEqual(['name', 'age', 'active']);
    expect(r.data.types).toEqual(['string', 'number', 'boolean']);
    expect(r.data.rows[0]).toEqual({ name: 'Ada', age: 36, active: true });
    expect(r.data.rows[1]).toEqual({ name: 'Alan', age: 41, active: false });
  });

  it('treats a mixed column as string', () => {
    const r = parseCsv('a\n1\nhello\n', limits);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.types).toEqual(['string']);
  });

  it('maps empty cells to null regardless of inferred type', () => {
    const r = parseCsv('a,b\n1,\n,x\n', limits);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.rows[0]!.b).toBeNull();
    expect(r.data.rows[1]!.a).toBeNull();
  });

  it('rejects an empty file', () => {
    expect(parseCsv('', limits).ok).toBe(false);
    expect(parseCsv('   \n', limits).ok).toBe(false);
  });

  it('rejects a header with an empty column name', () => {
    expect(parseCsv('a,,c\n1,2,3\n', limits).ok).toBe(false);
  });

  it('rejects duplicate column names', () => {
    expect(parseCsv('a,a\n1,2\n', limits).ok).toBe(false);
  });

  it('enforces the column and row caps', () => {
    expect(parseCsv('a\n1\n', { maxRows: 1000, maxColumns: 0 }).ok).toBe(false);
    expect(parseCsv('a\n1\n2\n3\n', { maxRows: 2, maxColumns: 20 }).ok).toBe(false);
  });

  it('is immune to a classic ReDoS-shaped field value (no catastrophic backtracking)', () => {
    const hostile = 'a'.repeat(5000) + '!';
    const start = Date.now();
    const r = parseCsv(`col\n"${hostile}"\n`, limits);
    expect(Date.now() - start).toBeLessThan(500);
    expect(r.ok).toBe(true);
  });
});
