/**
 * Prompt manager for agent services.
 *
 * Two modes:
 *
 * 1. **Section mode** (default) — each subsystem calls set(name, text) to register
 *    an independent section. commit() concatenates all sections and writes to disk.
 *    No init() needed. Sections can be set/updated independently at any time.
 *
 * 2. **Template mode** — call init(template) with {{var}} placeholders, then set()
 *    fills vars, and commit() validates all vars are filled before rendering.
 *    Use this when multiple vars compose a single section.
 */
import fs from 'fs';
import path from 'path';

import { log } from './ipc.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptManager {
  /** Initialize with a template string. Use {{varName}} for placeholders. Enables template mode. */
  init(template: string): void;
  /** Clear template and all sections/vars. Returns to section mode. */
  reset(): void;
  /** Set a named section (section mode) or template variable (template mode). */
  set(name: string, value: string): void;
  /** Render and write to disk. In template mode, validates all vars are filled. */
  commit(): void;
  /** Write raw text directly to service-context.md, bypassing template/sections entirely. */
  commitRaw(text: string): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VAR_PATTERN = /\{\{(\w+)\}\}/g;

/** Extract all {{varName}} placeholder names from a template string. */
function extractVars(template: string): Set<string> {
  const vars = new Set<string>();
  let match;
  while ((match = VAR_PATTERN.exec(template)) !== null) {
    vars.add(match[1]!);
  }
  return vars;
}

export function createPromptManager(agentFolder: string, outputPath: string): PromptManager {
  let template: string | null = null;
  const sections = new Map<string, string>();

  function writeToDisk(content: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, content, 'utf-8');
  }

  return {
    init(tmpl: string): void {
      if (template !== null) {
        throw new Error('Prompt already initialized. Call reset() before re-initializing.');
      }
      template = tmpl;
    },

    reset(): void {
      template = null;
      sections.clear();
    },

    set(name: string, value: string): void {
      sections.set(name, value);
    },

    commit(): void {
      if (template !== null) {
        // Template mode: validate all vars are filled, then render
        const templateVars = extractVars(template);

        const unfilled: string[] = [];
        for (const v of templateVars) {
          if (!sections.has(v)) unfilled.push(v);
        }
        if (unfilled.length > 0) {
          throw new Error(`Prompt has unfilled vars: {{${unfilled.join('}}, {{')}}}. Set them before committing.`);
        }

        for (const v of sections.keys()) {
          if (!templateVars.has(v)) {
            log(agentFolder, `Prompt warning: var '${v}' is set but not in template (orphaned)`);
          }
        }

        const rendered = template.replace(VAR_PATTERN, (_match, name: string) => sections.get(name) ?? '');
        writeToDisk(rendered);
      } else {
        // Section mode: concatenate all non-empty sections
        const parts: string[] = [];
        for (const value of sections.values()) {
          if (value) parts.push(value);
        }
        writeToDisk(parts.join('\n\n'));
      }
    },

    commitRaw(text: string): void {
      writeToDisk(text);
    },
  };
}
