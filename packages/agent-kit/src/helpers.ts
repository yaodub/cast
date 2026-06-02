import fs from 'fs';
import path from 'path';

import * as p from '@clack/prompts';
import type { ZodType } from 'zod';

import { DEFAULT_AGENTS_DIR } from './paths.js';

export function listSubdirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const INSTANCE_MARKER = '<!-- instance -->';

/**
 * Recursively copy a directory.
 * When `backup` is true, existing files at the destination are renamed to `.bak`
 * before being overwritten (only if contents differ). This preserves user edits
 * during template restamps.
 *
 * For text files (.md, .json, .txt): if the existing file contains an
 * `<!-- instance -->` marker, content below the marker is preserved and
 * appended to the new template content on restamp.
 */
export function copyDirRecursive(src: string, dest: string, backup = false): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '.DS_Store' || entry.name === 'node_modules' || entry.name.endsWith('.secrets.json')) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, backup);
    } else {
      if (backup && fs.existsSync(destPath)) {
        const instanceContent = extractInstanceContent(destPath);
        const oldContent = fs.readFileSync(destPath);
        const newContent = fs.readFileSync(srcPath);
        if (!oldContent.equals(newContent)) {
          fs.renameSync(destPath, destPath + '.bak');
        }
        if (instanceContent !== null) {
          // Merge: template content (up to its own marker, if any) + preserved instance content
          const templateText = fs.readFileSync(srcPath, 'utf-8');
          const markerIdx = templateText.indexOf(INSTANCE_MARKER);
          const templateAbove = markerIdx === -1 ? templateText : templateText.slice(0, markerIdx);
          fs.writeFileSync(destPath, templateAbove.trimEnd() + '\n\n' + INSTANCE_MARKER + '\n' + instanceContent);
          continue;
        }
      }
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Extract content below the `<!-- instance -->` marker from a file.
 * Returns null if the file doesn't contain the marker or isn't a text file.
 */
function extractInstanceContent(filePath: string): string | null {
  if (!/\.(md|txt|json)$/.test(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const idx = content.indexOf(INSTANCE_MARKER);
    if (idx === -1) return null;
    const below = content.slice(idx + INSTANCE_MARKER.length);
    return below.trimStart() ? below.trimStart() : null;
  } catch {
    return null;
  }
}

/** Parse a JSON file against a Zod schema. Returns null if missing or corrupt. */
export function parseJsonFile<T>(filePath: string, schema: ZodType<T>): T | null {
  try {
    return schema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return null;
  }
}

export function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function listAgentFolders(agentsDir = DEFAULT_AGENTS_DIR): string[] {
  return listSubdirectories(agentsDir);
}

export function bail(): never {
  p.cancel('Cancelled.');
  process.exit(0);
}

/** Parse --key value pairs from argv after position `start`. */
export function parseFlags(start: number): Record<string, string> {
  const flags: Record<string, string> = {};
  const args = process.argv;
  for (let i = start; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  return flags;
}
