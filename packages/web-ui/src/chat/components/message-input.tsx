import { useState, useRef, useCallback } from 'preact/hooks';

const LINE_HEIGHT = 20;
const MAX_ROWS = 5;

export interface PendingFile {
  id: string;
  file: File;
  preview?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
  pendingFiles: PendingFile[];
  onSend: (text: string) => void;
  onStageFiles: (files: File[] | FileList) => void;
  onUnstageFile: (id: string) => void;
}

export function MessageInput({ pendingFiles, onSend, onStageFiles, onUnstageFile }: Props) {
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = LINE_HEIGHT * MAX_ROWS;
    const newHeight = Math.min(el.scrollHeight, maxHeight);
    el.style.height = `${newHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  function handleSubmit(e: Event): void {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    onSend(trimmed || (pendingFiles.length > 0 ? `[Attached ${pendingFiles.length} file${pendingFiles.length > 1 ? 's' : ''}]` : ''));
    setText('');
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) el.style.height = 'auto';
    });
  }

  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    if (input.files?.length) {
      onStageFiles(input.files);
    }
    input.value = '';
  }

  return (
    // Footer is transparent — the input pill itself is the floating
    // element. No top divider; the messages canvas continues unbroken
    // up to the input.
    <div class="shrink-0">
      {/* Pending files preview */}
      {pendingFiles.length > 0 && (
        <div class="px-5 pt-3 pb-1 flex gap-3 flex-wrap">
          {pendingFiles.map((pf: PendingFile) => (
            <div key={pf.id} class="relative group">
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} class="h-24 max-w-48 object-cover rounded-lg" />
              ) : (
                <div class="h-24 w-28 bg-gray-800 rounded-lg flex flex-col items-center justify-center gap-1 px-2">
                  <svg class="w-6 h-6 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                  </svg>
                  <span class="text-[10px] text-gray-400 uppercase font-medium">{pf.file.name.split('.').pop()}</span>
                  <span class="text-[9px] text-gray-500 truncate w-full text-center">{formatFileSize(pf.file.size)}</span>
                </div>
              )}
              <button
                onClick={() => onUnstageFile(pf.id)}
                class="absolute -top-2 -right-2 w-5 h-5 bg-gray-600 rounded-full text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-gray-500"
              >
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
              <div class="text-[10px] text-gray-500 truncate max-w-28 mt-1">{pf.file.name}</div>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleSubmit} class="p-4 flex items-end gap-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          class="p-2 text-gray-500 hover:text-gray-300 transition-colors rounded-full hover:bg-gray-700"
          title="Attach file"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>
        <input ref={fileRef} type="file" class="hidden" multiple onChange={handleFileChange} />
        <textarea
          ref={textareaRef}
          value={text}
          onInput={(e) => { setText((e.target as HTMLTextAreaElement).value); autoResize(); }}
          onKeyDown={handleKeyDown}
          placeholder={pendingFiles.length > 0 ? 'Add a message or press Enter to send...' : 'Type a message...'}
          rows={1}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
          class="flex-1 px-4 py-2.5 bg-gray-800 rounded-2xl text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-teal-600 resize-none overflow-hidden"
        />
        <button
          type="submit"
          disabled={!text.trim() && pendingFiles.length === 0}
          class="p-2.5 bg-teal-600 hover:bg-teal-500 text-white rounded-full disabled:opacity-30 transition-colors"
        >
          <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14m-4-4l4 4-4 4" />
          </svg>
        </button>
      </form>
    </div>
  );
}
