/**
 * UiDirective — the structured-intent payload cast emits as a `ui_directive`
 * SSE event. The admin UI interprets each variant; cast doesn't pick render
 * (route push, drawer tab, modal, anchor scroll, layout reflow are all UI
 * decisions). Discriminated union split by what cast is asking for, never
 * by how the UI renders.
 *
 * Two variants today:
 *   - `show`: move the operator's attention to a target surface.
 *   - `hint`: advise UI presentation without moving attention (open vocabulary).
 */
import { z } from 'zod';

/**
 * Move the operator's attention to a target surface. The `target` is a
 * logical key from the page-manual vocabulary (e.g. `'/agents/foo/access'`,
 * `'config-manager'`); the UI resolves it to a router push, drawer tab,
 * modal, or whatever fits.
 */
export const ShowDirectiveSchema = z.object({
  type: z.literal('show'),
  target: z.string().min(1),
  /** Optional sub-location within target (section anchor, sub-tab id). */
  within: z.string().optional(),
  /** One sentence narrating WHY — rendered verbatim by non-browser transports. */
  reason: z.string().min(1),
});

/**
 * UI-presentation hint. Does not move the operator's view. Open
 * key/value vocabulary the UI agrees to honour or ignore — first
 * concrete consumer is the chat-position layout suggestion.
 */
export const HintDirectiveSchema = z.object({
  type: z.literal('hint'),
  key: z.string().min(1),
  value: z.string().min(1),
  reason: z.string().min(1),
});

export const UiDirectiveSchema = z.discriminatedUnion('type', [
  ShowDirectiveSchema,
  HintDirectiveSchema,
]);

export type ShowDirective = z.infer<typeof ShowDirectiveSchema>;
export type HintDirective = z.infer<typeof HintDirectiveSchema>;
export type UiDirective = z.infer<typeof UiDirectiveSchema>;

/** Envelope that wraps a UiDirective when sent over the SSE event stream. */
export const UiDirectiveEventDataSchema = z.object({
  channel: z.string().optional(),
  directive: UiDirectiveSchema.optional(),
});

export type UiDirectiveEventData = z.infer<typeof UiDirectiveEventDataSchema>;
