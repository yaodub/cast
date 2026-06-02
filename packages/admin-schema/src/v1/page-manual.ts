/**
 * Page-manual schemas — the admin UI publishes a manifest of viewable intents
 * (page paths + section anchors + purposes); cast loads it and surfaces it to
 * console agents in their prompts as the catalogue of `admin__navigate`
 * destinations.
 *
 * Producer (web-ui): each page exports a `PageManualEntry`; the aggregator
 * imports them and a Vite plugin serializes to `dist/admin-manual.json`.
 * Consumer (cast): reads the JSON, Zod-parses to `AdminManual`, renders into
 * each console session's dynamic prompt snapshot.
 *
 * Granularity capped at section — no per-field/per-button entries.
 */
import { z } from 'zod';

export const PageManualSectionSchema = z.object({
  /** Stable DOM id on the section heading. `admin__navigate`'s `anchor` arg matches this. */
  anchor: z.string(),
  /** One short line on what this section is for. */
  purpose: z.string(),
  /** Operator-visible actions on this section. Keep terse. */
  actions: z.array(z.string()).default([]),
});

export const PageManualEntrySchema = z.object({
  /** One short line on what this page is for. */
  purpose: z.string(),
  /** Operator-visible actions when the page has no distinct sections. */
  actions: z.array(z.string()).optional(),
  /** Distinct sections within the page. Each gets its own anchor. */
  sections: z.array(PageManualSectionSchema).optional(),
});

/** Map route pattern → entry. Keys are wouter paths, e.g. `/agents/:alias/access`. */
export const AdminManualSchema = z.record(z.string(), PageManualEntrySchema);

export type PageManualSection = z.infer<typeof PageManualSectionSchema>;
export type PageManualEntry = z.infer<typeof PageManualEntrySchema>;
export type AdminManual = z.infer<typeof AdminManualSchema>;
