/**
 * Shared UI components for extension admin pages.
 *
 * Dark mode styling: gray-950 inputs, gray-700 borders,
 * teal-500 accents (interactive-chrome leitmotif), disabled inputs use gray-900/gray-800.
 */
import { useState } from 'preact/hooks';
import type { ComponentChildren, JSX } from 'preact';

// ---------------------------------------------------------------------------
// Lock icon
// ---------------------------------------------------------------------------

export function LockIcon() {
  return (
    <svg class="inline w-3.5 h-3.5 text-gray-500 ml-1" fill="none" stroke="currentColor" viewBox="0 0 24 24" title="Locked by author">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Section heading
// ---------------------------------------------------------------------------

export function SectionHeading({ children }: { children: ComponentChildren }) {
  return (
    <h3 class="text-sm font-medium text-gray-300 border-b border-gray-800 pb-1 mb-3">
      {children}
    </h3>
  );
}

// ---------------------------------------------------------------------------
// Status message
// ---------------------------------------------------------------------------

export function StatusMessage({ type, text }: { type: 'ok' | 'error'; text: string }) {
  return (
    <p class={`text-sm ${type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
      {text}
    </p>
  );
}

// ---------------------------------------------------------------------------
// Info box
// ---------------------------------------------------------------------------

export function InfoBox({ children }: { children: ComponentChildren }) {
  return (
    <div class="bg-gray-900/50 border border-gray-800 rounded px-3 py-2 text-xs text-gray-500">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Save button
// ---------------------------------------------------------------------------

export function SaveButton({ pending, label }: { pending: boolean; label?: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded font-medium transition-colors"
    >
      {pending ? 'Saving...' : (label ?? 'Save')}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Text input
// ---------------------------------------------------------------------------

const inputBase = 'w-full px-3 py-2 border rounded text-sm focus:outline-none focus:border-teal-500';

export function TextInput({
  label,
  value,
  onInput,
  locked,
  placeholder,
  helpText,
  type,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  locked?: boolean;
  placeholder?: string;
  helpText?: string;
  type?: string;
}) {
  return (
    <div>
      <label class="block text-sm text-gray-400 mb-1">
        {label}
        {locked && <LockIcon />}
      </label>
      <input
        type={type ?? 'text'}
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        disabled={locked}
        placeholder={placeholder}
        class={`${inputBase} ${
          locked
            ? 'bg-gray-900 border-gray-800 text-gray-500 cursor-not-allowed'
            : 'bg-gray-950 border-gray-700 text-white'
        }`}
      />
      {helpText && <p class="text-xs text-gray-600 mt-1">{helpText}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Number input
// ---------------------------------------------------------------------------

export function NumberInput({
  label,
  value,
  onInput,
  locked,
  placeholder,
  helpText,
}: {
  label: string;
  value: number | string;
  onInput: (v: string) => void;
  locked?: boolean;
  placeholder?: string;
  helpText?: string;
}) {
  return (
    <TextInput
      label={label}
      value={String(value ?? '')}
      onInput={onInput}
      locked={locked}
      placeholder={placeholder}
      helpText={helpText}
      type="number"
    />
  );
}

// ---------------------------------------------------------------------------
// Secret input
// ---------------------------------------------------------------------------

export function SecretInput({
  label,
  value,
  onInput,
  isSet,
  helpText,
}: {
  label: string;
  value: string;
  onInput: (v: string) => void;
  isSet: boolean;
  helpText?: string;
}) {
  return (
    <div>
      <label class="block text-sm text-gray-400 mb-1">
        {label}
        {isSet && <span class="text-green-500 text-xs ml-2">Set</span>}
      </label>
      <input
        type="password"
        value={value}
        onInput={(e) => onInput((e.target as HTMLInputElement).value)}
        placeholder={isSet ? '(unchanged)' : 'Enter value'}
        class={`${inputBase} bg-gray-950 border-gray-700 text-white`}
      />
      {helpText && <p class="text-xs text-gray-600 mt-1">{helpText}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select input
// ---------------------------------------------------------------------------

export function SelectInput({
  label,
  value,
  options,
  onChange,
  locked,
  helpText,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  locked?: boolean;
  helpText?: string;
}) {
  return (
    <div>
      <label class="block text-sm text-gray-400 mb-1">
        {label}
        {locked && <LockIcon />}
      </label>
      <select
        value={value}
        onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
        disabled={locked}
        class={`${inputBase} ${
          locked
            ? 'bg-gray-900 border-gray-800 text-gray-500 cursor-not-allowed'
            : 'bg-gray-950 border-gray-700 text-white'
        }`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      {helpText && <p class="text-xs text-gray-600 mt-1">{helpText}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle input
// ---------------------------------------------------------------------------

export function ToggleInput({
  label,
  value,
  onChange,
  locked,
  helpText,
  helpAction,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  locked?: boolean;
  helpText?: string;
  /** Optional inline element rendered next to the label — typically a `<HelpButton/>`. */
  helpAction?: JSX.Element;
}) {
  return (
    <div class="flex items-start gap-3">
      <button
        type="button"
        onClick={() => !locked && onChange(!value)}
        disabled={locked}
        class={`mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${
          locked ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
        } ${value ? 'bg-teal-600' : 'bg-gray-700'}`}
      >
        <span
          class={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ${
            value ? 'translate-x-4' : 'translate-x-0'
          }`}
        />
      </button>
      <div>
        <span class="flex items-center gap-2 text-sm text-gray-400">
          {label}
          {locked && <LockIcon />}
          {helpAction}
        </span>
        {helpText && <p class="text-xs text-gray-600 mt-0.5">{helpText}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List input (tag-style add/remove)
// ---------------------------------------------------------------------------

export function ListInput({
  label,
  values,
  onChange,
  locked,
  placeholder,
  helpText,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  locked?: boolean;
  placeholder?: string;
  helpText?: string;
}) {
  const [draft, setDraft] = useState('');

  const addItem = () => {
    const trimmed = draft.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setDraft('');
  };

  const removeItem = (index: number) => {
    onChange(values.filter((_, i) => i !== index));
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addItem();
    }
  };

  return (
    <div>
      <label class="block text-sm text-gray-400 mb-1">
        {label}
        {locked && <LockIcon />}
      </label>
      {values.length > 0 && (
        <div class="flex flex-wrap gap-1 mb-2">
          {values.map((item, i) => (
            <span
              key={`${item}-${i}`}
              class={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                locked ? 'bg-gray-900 text-gray-500' : 'bg-gray-800 text-gray-300'
              }`}
            >
              {item}
              {!locked && (
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  class="text-gray-500 hover:text-gray-300"
                >
                  x
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      {!locked && (
        <div class="flex gap-2">
          <input
            type="text"
            value={draft}
            onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder ?? 'Add item...'}
            class={`flex-1 ${inputBase} bg-gray-950 border-gray-700 text-white`}
          />
          <button
            type="button"
            onClick={addItem}
            class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded"
          >
            Add
          </button>
        </div>
      )}
      {helpText && <p class="text-xs text-gray-600 mt-1">{helpText}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test connection button
// ---------------------------------------------------------------------------

export function TestConnectionButton({
  onClick,
  pending,
  result,
}: {
  onClick: () => void;
  pending: boolean;
  result: { ok: boolean; message: string } | null;
}) {
  return (
    <div class="space-y-2">
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        class="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm rounded font-medium"
      >
        {pending ? 'Testing...' : 'Test Connection'}
      </button>
      {result && (
        <StatusMessage type={result.ok ? 'ok' : 'error'} text={result.message} />
      )}
    </div>
  );
}
