/**
 * Tests for detectAutoResponder. Exercises both branches per the
 * both-branches discipline: every rule has a reject case (the rule fires)
 * and the suite includes allow cases (the rule does not fire on human
 * mail). Headers are produced by simpleParser on synthetic RFC 5322
 * source so the test sees the same Map shape the watcher does in prod.
 */
import { describe, it, expect } from 'vitest';
import { simpleParser } from 'mailparser';

import { detectAutoResponder } from './auto-responder.js';

async function headersFrom(headerBlock: string): Promise<Awaited<ReturnType<typeof simpleParser>>['headers']> {
  const source = `${headerBlock}\r\nFrom: alice@example.com\r\nTo: bob@example.com\r\nSubject: t\r\n\r\nbody`;
  const parsed = await simpleParser(source);
  return parsed.headers;
}

describe('detectAutoResponder — reject branch (auto-generated mail)', () => {
  it('Auto-Submitted: auto-replied → detected', async () => {
    const headers = await headersFrom('Auto-Submitted: auto-replied');
    expect(detectAutoResponder(headers)).toMatch(/^Auto-Submitted:/);
  });

  it('Auto-Submitted: auto-generated → detected', async () => {
    const headers = await headersFrom('Auto-Submitted: auto-generated');
    expect(detectAutoResponder(headers)).toMatch(/^Auto-Submitted:/);
  });

  it('Auto-Submitted: auto-replied (server.example.com) — parenthesized comment → detected', async () => {
    const headers = await headersFrom('Auto-Submitted: auto-replied (server.example.com)');
    expect(detectAutoResponder(headers)).toMatch(/^Auto-Submitted:/);
  });

  it('Auto-Submitted: AUTO-REPLIED — case-insensitive → detected', async () => {
    const headers = await headersFrom('Auto-Submitted: AUTO-REPLIED');
    expect(detectAutoResponder(headers)).toMatch(/^Auto-Submitted:/);
  });

  it('Precedence: bulk → detected', async () => {
    const headers = await headersFrom('Precedence: bulk');
    expect(detectAutoResponder(headers)).toMatch(/^Precedence: bulk/);
  });

  it('Precedence: list → detected (mailing list)', async () => {
    const headers = await headersFrom('Precedence: list');
    expect(detectAutoResponder(headers)).toMatch(/^Precedence: list/);
  });

  it('Precedence: junk → detected', async () => {
    const headers = await headersFrom('Precedence: junk');
    expect(detectAutoResponder(headers)).toMatch(/^Precedence: junk/);
  });

  it('Precedence: auto_reply (vendor variant) → detected', async () => {
    const headers = await headersFrom('Precedence: auto_reply');
    expect(detectAutoResponder(headers)).toMatch(/^Precedence:/);
  });

  it('X-Autoreply present → detected regardless of value', async () => {
    const headers = await headersFrom('X-Autoreply: yes');
    expect(detectAutoResponder(headers)).toMatch(/^x-autoreply/);
  });

  it('X-Auto-Response-Suppress present → detected', async () => {
    const headers = await headersFrom('X-Auto-Response-Suppress: All');
    expect(detectAutoResponder(headers)).toMatch(/^x-auto-response-suppress/);
  });

  it('List-Id present → detected (mailing list traffic)', async () => {
    const headers = await headersFrom('List-Id: <updates.example.com>');
    expect(detectAutoResponder(headers)).toMatch(/^List-Id/);
  });

  it('List-Unsubscribe present → detected (newsletter)', async () => {
    const headers = await headersFrom('List-Unsubscribe: <mailto:unsub@example.com>');
    expect(detectAutoResponder(headers)).toMatch(/^List-Unsubscribe/);
  });
});

describe('detectAutoResponder — allow branch (human-authored mail)', () => {
  it('plain message with no markers → not detected', async () => {
    const headers = await headersFrom('');
    expect(detectAutoResponder(headers)).toBeUndefined();
  });

  it('Auto-Submitted: no → not detected (the RFC-3834 escape value)', async () => {
    const headers = await headersFrom('Auto-Submitted: no');
    expect(detectAutoResponder(headers)).toBeUndefined();
  });

  it('Precedence: normal → not detected', async () => {
    const headers = await headersFrom('Precedence: normal');
    expect(detectAutoResponder(headers)).toBeUndefined();
  });

  it('In-Reply-To alone → not detected (replies are normal mail)', async () => {
    // Threading headers carry no auto-generation signal — a human reply has
    // them too. The detector must not over-fire on the presence of In-Reply-To.
    const headers = await headersFrom('In-Reply-To: <prev@example.com>\r\nReferences: <prev@example.com>');
    expect(detectAutoResponder(headers)).toBeUndefined();
  });
});
