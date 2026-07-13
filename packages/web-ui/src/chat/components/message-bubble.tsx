import { useMemo, useState, useEffect } from 'preact/hooks';
import type { StoredMessage, MessageAttachment, MessageMeta } from '../lib/store';
import { getAttachment, respondToApproval, explainApproval } from '../lib/store';
import { renderMarkdown } from '../../lib/markdown';

interface Props {
  message: StoredMessage;
  currentHandle: string | null;
}

export function MessageBubble({ message, currentHandle }: Props) {
  const isUser = currentHandle != null && (message.from === currentHandle || message.from.includes(`/${currentHandle}`));
  const hasAttachments = message.attachments && message.attachments.length > 0;

  // Special rendering based on structured metadata
  if (message.meta) {
    return (
      <div class="flex flex-col items-start">
        <MetaCard meta={message.meta} timestamp={message.timestamp} />
      </div>
    );
  }

  const html = useMemo(() => {
    if (isUser) return null;
    return renderMarkdown(message.text);
  }, [message.text, isUser]);

  return (
    <div class={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      {message.text && (
        <div
          class={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm ${
            isUser
              ? 'bg-teal-800 text-gray-100 rounded-tr-sm'
              : 'bg-gray-800 text-gray-200 rounded-tl-sm'
          }`}
        >
          {isUser ? (
            <p class="whitespace-pre-wrap break-words">{message.text}</p>
          ) : (
            <div
              class="prose prose-invert prose-sm max-w-none break-words leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_pre]:bg-gray-900 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-3 [&_code]:text-teal-300 [&_a]:text-teal-400 [&_blockquote]:border-gray-600 [&_blockquote]:text-gray-400 [&_hr]:border-gray-700 [&_hr]:my-3 [&_table]:border-collapse [&_table]:text-xs [&_table]:w-full [&_th]:bg-gray-900 [&_th]:px-3 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-gray-300 [&_th]:border-b [&_th]:border-gray-700 [&_td]:px-3 [&_td]:py-1.5 [&_td]:border-b [&_td]:border-gray-700/50 [&_tr:last-child_td]:border-0"
              dangerouslySetInnerHTML={{ __html: html! }}
            />
          )}
          <div class={`text-[10px] mt-1 ${isUser ? 'text-teal-400/50' : 'text-gray-500'}`}>
            {new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        </div>
      )}

      {hasAttachments && (
        <div class={`flex flex-wrap gap-2 mt-1 max-w-[75%] ${isUser ? 'justify-end' : 'justify-start'}`}>
          {message.attachments!.map((att, i) => (
            <AttachmentView key={`${message.id}-att-${i}`} attachment={att} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// MetaCard — switches on meta.type for special message rendering
// ---------------------------------------------------------------------------

function MetaCard({ meta, timestamp }: { meta: MessageMeta; timestamp: string }) {
  switch (meta.type) {
    case 'approval_request':
      return <ApprovalRequestCard meta={meta} timestamp={timestamp} />;
    case 'approval_ack':
      return <ApprovalAckCard meta={meta} timestamp={timestamp} />;
  }
}

function Timestamp({ timestamp }: { timestamp: string }) {
  return (
    <span class="text-[10px] text-gray-500 ml-auto">
      {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}

function ApprovalRequestCard({ meta, timestamp }: { meta: Extract<MessageMeta, { type: 'approval_request' }>; timestamp: string }) {
  return (
    <div class="relative max-w-[75%] rounded-xl bg-gray-800/80 px-4 py-3 text-sm">
      <button
        onClick={() => explainApproval(meta.approvalId, meta.summary)}
        class="absolute top-2.5 right-2.5 w-5 h-5 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-colors"
        title="Ask the agent to explain"
      >
        <svg class="w-5 h-5" viewBox="0 -960 960 960" fill="currentColor">
          <path d="M513.5-254.5Q528-269 528-290t-14.5-35.5Q499-340 478-340t-35.5 14.5Q428-311 428-290t14.5 35.5Q457-240 478-240t35.5-14.5ZM442-394h74q0-33 7.5-52t42.5-52q26-26 41-49.5t15-56.5q0-56-41-86t-97-30q-57 0-92.5 30T342-618l66 26q5-18 22.5-39t53.5-21q32 0 48 17.5t16 38.5q0 20-12 37.5T506-526q-44 39-54 59t-10 73Zm38 314q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z" />
        </svg>
      </button>
      <div class="flex items-center gap-2 text-gray-300 font-medium pr-6">
        <span>Approval needed</span>
        <Timestamp timestamp={timestamp} />
      </div>
      <p class="text-gray-400 mt-1">{meta.summary}</p>
      {meta.details && <p class="text-gray-500 text-xs mt-1">{meta.details}</p>}
      {meta.expiresAt && (
        <p class="text-gray-600 text-[10px] mt-1">Expires {new Date(meta.expiresAt).toLocaleTimeString()}</p>
      )}
      <div class="flex flex-wrap gap-2 mt-3">
        <button
          onClick={() => respondToApproval(meta.approvalId, 'approved', 'once')}
          class="px-3 py-1.5 rounded-lg bg-teal-700/60 text-teal-200 text-xs font-medium hover:bg-teal-700 transition-colors"
        >
          Approve
        </button>
        {meta.tiered && (
          <button
            onClick={() => respondToApproval(meta.approvalId, 'approved', 'always')}
            class="px-3 py-1.5 rounded-lg bg-teal-700/60 text-teal-200 text-xs font-medium hover:bg-teal-700 transition-colors"
          >
            Always approve
          </button>
        )}
        <button
          onClick={() => respondToApproval(meta.approvalId, 'rejected', 'once')}
          class="px-3 py-1.5 rounded-lg bg-gray-700/60 text-gray-300 text-xs font-medium hover:bg-gray-600 transition-colors"
        >
          Reject
        </button>
        {meta.tiered && (
          <button
            onClick={() => respondToApproval(meta.approvalId, 'rejected', 'always')}
            class="px-3 py-1.5 rounded-lg bg-gray-700/60 text-gray-300 text-xs font-medium hover:bg-gray-600 transition-colors"
          >
            Always reject
          </button>
        )}
      </div>
    </div>
  );
}

function ApprovalAckCard({ meta, timestamp }: { meta: Extract<MessageMeta, { type: 'approval_ack' }>; timestamp: string }) {
  const icon = meta.decision === 'approved' ? '✅' : meta.decision === 'rejected' ? '❌' : '⏰';
  const base = meta.decision.charAt(0).toUpperCase() + meta.decision.slice(1);
  // Surface the tier so the ack reads as the action taken: "Always approved" /
  // "Always rejected" when a standing grant/tombstone was written, plain
  // "Approved" / "Rejected" for a one-shot. (`expired` carries no tier.)
  const label = meta.tier === 'always' && meta.decision !== 'expired' ? `Always ${meta.decision}` : base;
  return (
    <div class="max-w-[75%] rounded-xl bg-gray-800/80 px-4 py-3 text-sm">
      <div class="flex items-center gap-2 text-gray-300 font-medium">
        <span>{icon}</span>
        <span>{label}</span>
        <Timestamp timestamp={timestamp} />
      </div>
      <p class="text-gray-400 mt-1">{meta.summary}</p>
      {meta.reason && <p class="text-gray-500 text-xs mt-1 italic">Reason: {meta.reason}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AttachmentView — state machine, useEffect, blob URL cleanup
// ---------------------------------------------------------------------------

type AttState =
  | { status: 'pending' }
  | { status: 'loading' }
  | { status: 'loaded'; url: string }
  | { status: 'failed' };

function AttachmentView({ attachment }: { attachment: MessageAttachment }) {
  const [state, setState] = useState<AttState>(
    attachment.hash ? { status: 'loading' } : { status: 'pending' },
  );

  // Fetch blob from IndexedDB with retry for binary frames that arrive after text
  useEffect(() => {
    if (!attachment.hash) return;
    let cancelled = false;
    let retries = 0;

    async function load(): Promise<void> {
      const result = await getAttachment(attachment.hash!);
      if (cancelled) return;
      if (result) {
        const ab = new ArrayBuffer(result.blob.byteLength);
        new Uint8Array(ab).set(result.blob);
        const url = URL.createObjectURL(new Blob([ab], { type: result.mimeType }));
        setState({ status: 'loaded', url });
      } else if (retries < 5) {
        retries++;
        setTimeout(load, 500);
      } else {
        setState({ status: 'failed' });
      }
    }
    load();

    return () => { cancelled = true; };
  }, [attachment.hash]);

  // Revoke blob URL on unmount or when state transitions away from 'loaded'
  useEffect(() => {
    return () => {
      if (state.status === 'loaded') URL.revokeObjectURL(state.url);
    };
  }, [state]);

  const isImage = attachment.mimeType.startsWith('image/');

  function openFile(): void {
    if (state.status !== 'loaded') return;
    if (isImage) {
      const w = window.open('', '_blank');
      if (w) {
        w.document.title = attachment.filename;
        w.document.body.style.margin = '0';
        w.document.body.style.background = '#000';
        const img = w.document.createElement('img');
        img.src = state.url;
        img.style.cssText = 'max-width:100%;max-height:100vh;display:block;margin:auto';
        w.document.body.appendChild(img);
      }
    } else {
      const a = document.createElement('a');
      a.href = state.url;
      a.download = attachment.filename;
      a.click();
    }
  }

  switch (state.status) {
    case 'loaded':
      if (isImage) {
        return (
          <button onClick={openFile} class="block">
            <img
              src={state.url}
              alt={attachment.filename}
              class="max-w-xs max-h-64 rounded-lg hover:brightness-110 transition"
            />
          </button>
        );
      }
      return (
        <button
          onClick={openFile}
          class="inline-flex items-center gap-1.5 px-3 py-2 bg-gray-700 rounded-lg text-xs text-gray-200 hover:bg-gray-600 transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {attachment.filename}
        </button>
      );

    case 'failed':
      return (
        <div class="inline-flex items-center gap-1.5 px-3 py-2 bg-gray-800/50 rounded-lg text-xs text-gray-500 italic">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4.5c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          {attachment.filename} (no longer in cache)
        </div>
      );

    case 'loading':
    case 'pending':
    default:
      return (
        <div class="inline-flex items-center gap-1.5 px-3 py-2 bg-gray-800 rounded-lg text-xs text-gray-400">
          <svg class="w-3.5 h-3.5 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
          {attachment.filename}
        </div>
      );
  }
}
