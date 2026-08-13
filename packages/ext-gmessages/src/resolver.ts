/**
 * Conversation resolution — turning a name / label / conversationId the agent
 * typed into a specific thread, with ambiguity surfaced rather than guessed.
 *
 * Unlike ext-whatsapp there is no local store: Google renders saved-contact
 * names into the listing itself (`ConversationSummary.participants` are DISPLAY
 * strings — see the library's api/types.ts), so resolution is a match over a
 * live listing plus operator `labels`, not a database lookup.
 *
 * All functions here are pure over a supplied list of views, so the matching
 * rules are testable without a network.
 */
import type { ConversationSummary } from 'gmessages';

/** A conversation as this extension shows and matches it. */
export interface ConversationView {
  readonly conversationId: string;
  /** Operator label if set, else the joined participant display names, else the id. */
  readonly label: string;
  readonly kind: 'sms' | 'rcs' | 'unknown';
  readonly participants: readonly string[];
  /**
   * Heuristic: more than one other participant reads as a group. The listing
   * carries no verified group flag (`groupIdOf` needs a per-thread read), so
   * this is advisory — display only, never a policy key.
   */
  readonly isGroup: boolean;
}

/** Project a library `ConversationSummary` into a view, applying operator labels. */
export function toView(
  summary: ConversationSummary,
  labels: Record<string, string>,
): ConversationView {
  const label =
    labels[summary.conversationId] ??
    (summary.participants.length > 0 ? summary.participants.join(', ') : summary.conversationId);
  return {
    conversationId: summary.conversationId,
    label,
    kind: summary.kind,
    participants: summary.participants,
    isGroup: summary.participants.length > 1,
  };
}

export type ResolveResult =
  | { readonly match: ConversationView; readonly ambiguous?: undefined }
  | { readonly match?: undefined; readonly ambiguous: readonly ConversationView[] }
  | { readonly match?: undefined; readonly ambiguous?: undefined };

/**
 * Resolve a query against a set of views.
 *
 * Precedence, each tier short-circuiting:
 *   1. exact conversationId
 *   2. exact (case-insensitive) label or participant match
 *   3. substring (case-insensitive) label or participant match
 *
 * A single hit in a tier resolves; multiple hits are ambiguous (the caller asks
 * the user to disambiguate); no hit falls through to the next tier, then to
 * "not found".
 */
export function resolveConversation(
  query: string,
  views: readonly ConversationView[],
): ResolveResult {
  const q = query.trim();
  if (q === '') return {};

  const byId = views.find((v) => v.conversationId === q);
  if (byId) return { match: byId };

  const lower = q.toLowerCase();
  const matchesName = (v: ConversationView, pred: (s: string) => boolean): boolean =>
    pred(v.label.toLowerCase()) || v.participants.some((p) => pred(p.toLowerCase()));

  const exact = views.filter((v) => matchesName(v, (s) => s === lower));
  if (exact.length === 1) return { match: exact[0]! };
  if (exact.length > 1) return { ambiguous: exact };

  const partial = views.filter((v) => matchesName(v, (s) => s.includes(lower)));
  if (partial.length === 1) return { match: partial[0]! };
  if (partial.length > 1) return { ambiguous: partial };

  return {};
}
