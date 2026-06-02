/**
 * Token counting and truncation utilities.
 *
 * Uses cl100k_base encoding (GPT-4 family) as a close approximation
 * for Claude tokenization. Exact counts differ but are accurate enough
 * for preview truncation.
 */
import { encodingForModel } from 'js-tiktoken';

const enc = encodingForModel('gpt-4o');

export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean; tokenCount: number } {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return { text, truncated: false, tokenCount: tokens.length };
  const truncated = String(enc.decode(tokens.slice(0, maxTokens)));
  return { text: truncated, truncated: true, tokenCount: tokens.length };
}
