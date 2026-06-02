/**
 * Typed query helpers for better-sqlite3.
 *
 * better-sqlite3 returns `unknown` from .all() and .get() because it can't
 * know the row shape at compile time. These helpers validate results with Zod
 * at the boundary so callers get typed, runtime-verified data without casts.
 */
import type { Statement } from 'better-sqlite3';
import type { z } from 'zod';

/** Run a query and validate each row against a Zod schema. */
export function queryAll<T>(stmt: Statement, schema: z.ZodType<T>, ...args: unknown[]): T[] {
  return (stmt.all(...args) as unknown[]).map((row) => schema.parse(row));
}

/** Run a query expecting zero or one row. Returns undefined if no row. */
export function queryOne<T>(stmt: Statement, schema: z.ZodType<T>, ...args: unknown[]): T | undefined {
  const row = stmt.get(...args);
  if (row === undefined) return undefined;
  return schema.parse(row);
}
