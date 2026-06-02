/**
 * Tests for `appendFeedRow` + `validateFeedIntegrity` + `feedAppendEvents`.
 *
 * Real filesystem (mkdtempSync) — exercises actual JSONL append + parse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { appendFeedRow, readFeedRows, validateFeedIntegrity, feedAppendEvents, type FeedAppendEvent } from './feed-format.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-feed-format-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  feedAppendEvents.removeAllListeners('append');
});

describe('validateFeedIntegrity', () => {
  it('treats missing file as valid empty feed (lastId: 0)', () => {
    const result = validateFeedIntegrity(path.join(tmpRoot, 'missing.jsonl'));
    expect(result).toEqual({ ok: true, lastId: 0 });
  });

  it('treats empty file as valid (lastId: 0)', () => {
    const p = path.join(tmpRoot, 'empty.jsonl');
    fs.writeFileSync(p, '');
    const result = validateFeedIntegrity(p);
    expect(result).toEqual({ ok: true, lastId: 0 });
  });

  it('returns lastId of well-formed feed', () => {
    const p = path.join(tmpRoot, 'good.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\n{"id":2,"data":{}}\n{"id":3,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result).toEqual({ ok: true, lastId: 3 });
  });

  it('skips blank lines without flagging corruption', () => {
    const p = path.join(tmpRoot, 'blank-lines.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\n\n  \n{"id":2,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result).toEqual({ ok: true, lastId: 2 });
  });

  it('detects JSON parse failure', () => {
    const p = path.join(tmpRoot, 'bad-json.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\nnot json\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('corrupt');
      expect(result.rowOffset).toBe(1);
      expect(result.reason).toContain('JSON parse');
    }
  });

  it('detects non-object row', () => {
    const p = path.join(tmpRoot, 'non-object.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\n42\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not an object');
  });

  it('detects missing id', () => {
    const p = path.join(tmpRoot, 'missing-id.jsonl');
    fs.writeFileSync(p, '{"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Missing or invalid id');
  });

  it('detects non-integer id', () => {
    const p = path.join(tmpRoot, 'float-id.jsonl');
    fs.writeFileSync(p, '{"id":1.5,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Missing or invalid id');
  });

  it('detects id < 1', () => {
    const p = path.join(tmpRoot, 'zero-id.jsonl');
    fs.writeFileSync(p, '{"id":0,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Missing or invalid id');
  });

  it('detects non-monotonic id (equal)', () => {
    const p = path.join(tmpRoot, 'duplicate-id.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\n{"id":1,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rowOffset).toBe(1);
      expect(result.reason).toContain('Non-monotonic');
    }
  });

  it('detects non-monotonic id (decreasing)', () => {
    const p = path.join(tmpRoot, 'decreasing-id.jsonl');
    fs.writeFileSync(p, '{"id":2,"data":{}}\n{"id":1,"data":{}}\n');
    const result = validateFeedIntegrity(p);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Non-monotonic');
  });
});

describe('appendFeedRow', () => {
  it('creates the file and assigns id=1 on first append', () => {
    const p = path.join(tmpRoot, 'new.jsonl');
    const result = appendFeedRow(p, 'k1', { msg: 'hello' });
    expect(result).toEqual({ ok: true, id: 1 });
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toBe('{"id":1,"data":{"msg":"hello"}}\n');
  });

  it('assigns id=lastId+1 on subsequent appends', () => {
    const p = path.join(tmpRoot, 'multi.jsonl');
    appendFeedRow(p, 'k1', { x: 1 });
    appendFeedRow(p, 'k1', { x: 2 });
    const result = appendFeedRow(p, 'k1', { x: 3 });
    expect(result).toEqual({ ok: true, id: 3 });
    const validate = validateFeedIntegrity(p);
    expect(validate).toEqual({ ok: true, lastId: 3 });
  });

  it('includes meta when provided', () => {
    const p = path.join(tmpRoot, 'with-meta.jsonl');
    appendFeedRow(p, 'k1', { msg: 'hi' }, { by: 'alice' });
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toBe('{"id":1,"data":{"msg":"hi"},"meta":{"by":"alice"}}\n');
  });

  it('omits meta key entirely when undefined', () => {
    const p = path.join(tmpRoot, 'no-meta.jsonl');
    appendFeedRow(p, 'k1', { msg: 'hi' });
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).not.toContain('meta');
  });

  it('accepts null and primitive data values', () => {
    const p = path.join(tmpRoot, 'primitives.jsonl');
    appendFeedRow(p, 'k1', null);
    appendFeedRow(p, 'k1', 'just a string');
    appendFeedRow(p, 'k1', 42);
    const validate = validateFeedIntegrity(p);
    expect(validate).toEqual({ ok: true, lastId: 3 });
  });

  it('fails closed when existing feed is corrupt', () => {
    const p = path.join(tmpRoot, 'corrupt.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\nnot json\n');
    const result = appendFeedRow(p, 'k1', { x: 1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('corrupt');
      expect(result.rowOffset).toBe(1);
    }
    // File unchanged after refusal
    const content = fs.readFileSync(p, 'utf-8');
    expect(content).toBe('{"id":1,"data":{}}\nnot json\n');
  });

  it('emits feedAppendEvents on successful append', () => {
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const p = path.join(tmpRoot, 'event.jsonl');
    appendFeedRow(p, 'conv-key-1', { msg: 'x' });
    appendFeedRow(p, 'conv-key-1', { msg: 'y' });
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ hostPath: p, convKey: 'conv-key-1', id: 1 });
    expect(events[1]).toEqual({ hostPath: p, convKey: 'conv-key-1', id: 2 });
  });

  it('does NOT emit feedAppendEvents when corruption causes refusal', () => {
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const p = path.join(tmpRoot, 'no-emit.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":{}}\nbad\n');
    appendFeedRow(p, 'k1', { x: 1 });
    expect(events).toHaveLength(0);
  });

  it('preserves convKey distinction across emissions', () => {
    const events: FeedAppendEvent[] = [];
    feedAppendEvents.on('append', (e) => events.push(e));
    const p = path.join(tmpRoot, 'multi-conv.jsonl');
    appendFeedRow(p, 'alice-key', { from: 'alice' });
    appendFeedRow(p, 'bob-key', { from: 'bob' });
    expect(events.map((e) => e.convKey)).toEqual(['alice-key', 'bob-key']);
  });
});

describe('readFeedRows', () => {
  it('returns empty rows for missing file', () => {
    const result = readFeedRows(path.join(tmpRoot, 'missing.jsonl'));
    expect(result).toEqual({ ok: true, rows: [] });
  });

  it('returns empty rows for empty file', () => {
    const p = path.join(tmpRoot, 'empty.jsonl');
    fs.writeFileSync(p, '');
    const result = readFeedRows(p);
    expect(result).toEqual({ ok: true, rows: [] });
  });

  it('parses well-formed rows preserving id, data, and meta', () => {
    const p = path.join(tmpRoot, 'rows.jsonl');
    appendFeedRow(p, 'k1', { msg: 'one' });
    appendFeedRow(p, 'k1', 'string-data', { tag: 'note' });
    appendFeedRow(p, 'k1', null);
    const result = readFeedRows(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      { id: 1, data: { msg: 'one' } },
      { id: 2, data: 'string-data', meta: { tag: 'note' } },
      { id: 3, data: null },
    ]);
  });

  it('skips blank lines', () => {
    const p = path.join(tmpRoot, 'blanks.jsonl');
    fs.writeFileSync(p, '\n{"id":1,"data":1}\n   \n{"id":2,"data":2}\n');
    const result = readFeedRows(p);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it('fails closed on JSON parse error', () => {
    const p = path.join(tmpRoot, 'bad-json.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":1}\nnot json\n');
    const result = readFeedRows(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
    expect(result.rowOffset).toBe(1);
  });

  it('fails closed on non-monotonic ids', () => {
    const p = path.join(tmpRoot, 'non-mono.jsonl');
    fs.writeFileSync(p, '{"id":1,"data":1}\n{"id":3,"data":3}\n{"id":2,"data":2}\n');
    const result = readFeedRows(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
    expect(result.rowOffset).toBe(2);
  });

  it('fails closed on missing id', () => {
    const p = path.join(tmpRoot, 'no-id.jsonl');
    fs.writeFileSync(p, '{"data":1}\n');
    const result = readFeedRows(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
    expect(result.rowOffset).toBe(0);
  });

  it('fails closed on non-object row', () => {
    const p = path.join(tmpRoot, 'not-obj.jsonl');
    fs.writeFileSync(p, '"a string row"\n');
    const result = readFeedRows(p);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('corrupt');
    expect(result.rowOffset).toBe(0);
  });
});
