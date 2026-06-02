/**
 * HelpButton — inline "i" mark next to a section heading. Click opens
 * the appropriate Configure surface for the current URL and asks the
 * bot about the named anchor (or the page itself if no anchor).
 *
 * Principle: the (i) is a UI projection of `PageManualEntry`. Place one
 * at — and only at — points the manual already declares (`section.anchor`,
 * or page-level when no anchor is given). The button takes no `alias`
 * or page-label props; everything is derived from the URL via
 * `useChatSelection().askHelp`. Per-agent vs server-scope routing is
 * automatic.
 */
import { useState } from 'preact/hooks';

import { useChatSelection } from '../layout';

interface Props {
  /** Section anchor on the current page's `PageManualEntry`. Omit for page-level help. */
  anchor?: string;
  /** Cosmetic label for tooltip / aria-label. Defaults to a title-cased anchor, or "this page". */
  label?: string;
}

export function HelpButton({ anchor, label }: Props) {
  const { askHelp } = useChatSelection();
  const [busy, setBusy] = useState(false);

  const aria = label ?? (anchor ? defaultLabel(anchor) : 'Help on this page');

  return (
    <button
      type="button"
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await askHelp({ anchor, label });
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      aria-label={aria}
      title={aria}
      class="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-700 text-gray-500 italic leading-none align-middle hover:border-gray-500 hover:text-gray-300 disabled:opacity-50 transition-colors"
      style="font-family: Georgia, 'Times New Roman', serif; font-size: 10px; font-weight: 600;"
    >
      i
    </button>
  );
}

/** `agent-peers` → `Agent peers`. Single-word anchors stay clean; multi-word
 *  kebab anchors title-case the first segment only. Override with `label`
 *  for tricky cases (`mcp-servers` reads better as "MCP servers"). */
function defaultLabel(anchor: string): string {
  const spaced = anchor.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
