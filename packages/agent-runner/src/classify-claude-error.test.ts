/**
 * Tests for the SDK error → typed failure reason classifier.
 *
 * The classifier inspects raw SDK result text and picks one of four host
 * fallback variants. Pattern-based (regex), so the test bed exercises each
 * regex with realistic SDK error formats.
 */
import { describe, it, expect } from 'vitest';
import { classifyClaudeError } from './index.js';

describe('classifyClaudeError', () => {
  it('matches 401 authentication error → invalid-credentials', () => {
    const text = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    expect(classifyClaudeError(text)).toBe('invalid-credentials');
  });

  it('matches 429 rate-limit / billing → quota-exhausted', () => {
    const text = 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"exceeded"}}';
    expect(classifyClaudeError(text)).toBe('quota-exhausted');
  });

  it('matches 5xx overloaded → claude-unavailable', () => {
    const text = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(classifyClaudeError(text)).toBe('claude-unavailable');
  });

  it('matches 500 → claude-unavailable', () => {
    const text = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}';
    expect(classifyClaudeError(text)).toBe('claude-unavailable');
  });

  it('does NOT match 401 when the prefix is wrong (anchored to start)', () => {
    const text = 'Some other error then API Error: 401 {"type":"error","error":{"type":"authentication_error"}}';
    // 401 regex is anchored to ^Failed to authenticate, so a prefix breaks it
    expect(classifyClaudeError(text)).toBeNull();
  });

  it('does NOT match an unrelated 400 status', () => {
    const text = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}';
    expect(classifyClaudeError(text)).toBeNull();
  });

  it('returns null for plain assistant text', () => {
    expect(classifyClaudeError('Sure, here is the answer to your question.')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(classifyClaudeError('')).toBeNull();
  });
});
