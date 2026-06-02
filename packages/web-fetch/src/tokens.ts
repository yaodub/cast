/**
 * Token estimation using tiktoken (o200k_base encoding, used by gpt-4o/claude).
 */

import { encoding_for_model } from 'tiktoken';
import type { Tiktoken } from 'tiktoken';

// SIDE EFFECT: Module-level encoder singleton, initialized on first use.
// Required because creating a tiktoken encoder is expensive. Pure alternative
// (pass encoder as parameter) would add noise to every countTokens() call site.
let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  if (!encoder) {
    encoder = encoding_for_model('gpt-4o');
  }
  return encoder;
}

/** Count tokens in a string. */
export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}
