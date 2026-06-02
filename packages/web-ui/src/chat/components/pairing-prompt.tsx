import { useState, useEffect } from 'preact/hooks';
import * as store from '../lib/store';

interface Props {
  agent: string;
}

type Step = 'idle' | 'requested' | 'verifying' | 'success' | 'failed';

// sessionStorage-keyed persistence for the pairing form. Switching browser
// windows or accidentally reloading the tab can remount this component
// (SharedWorker reconnect → setActiveIdentity in chat/lib/store.ts briefly
// clears `agents.value`, which flips MainLayout between PairingPrompt and
// ChatArea). The form state must survive that — operators step away to
// fetch the code from the operator and come back, sometimes after a
// reload. Map-in-module would survive remount but not reload; sessionStorage
// survives both.
const STORAGE_PREFIX = 'cast:pairing-prompt:';

interface Persisted {
  step: Step;
  code: string;
}

function load(agent: string): Persisted {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + agent);
    if (!raw) return { step: 'idle', code: '' };
    const parsed = JSON.parse(raw) as Persisted;
    return {
      step: parsed.step ?? 'idle',
      code: typeof parsed.code === 'string' ? parsed.code : '',
    };
  } catch {
    return { step: 'idle', code: '' };
  }
}

function save(agent: string, value: Persisted): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + agent, JSON.stringify(value));
  } catch {
    // Quota or disabled storage — non-fatal, prompt just won't persist.
  }
}

function clear(agent: string): void {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + agent);
  } catch {
    // ignore
  }
}

export function PairingPrompt({ agent }: Props) {
  const initial = load(agent);
  const [code, setCodeRaw] = useState(initial.code);
  const [step, setStepRaw] = useState<Step>(initial.step);

  // Preact reconciles `<PairingPrompt agent="...">` across agent changes
  // without remounting — useState initializers only run once. Detect the
  // prop change in render and reload form state from sessionStorage for
  // the new agent. (Not a useEffect — we want the new state on the very
  // first render after the switch, not one paint later.)
  const [prevAgent, setPrevAgent] = useState(agent);
  if (agent !== prevAgent) {
    setPrevAgent(agent);
    const next = load(agent);
    setCodeRaw(next.code);
    setStepRaw(next.step);
  }

  const setStep = (next: Step): void => {
    setStepRaw(next);
    save(agent, { step: next, code });
  };
  const setCode = (next: string): void => {
    setCodeRaw(next);
    save(agent, { step, code: next });
  };

  // Watch agents list — if this agent appears, pairing succeeded
  const isPaired = store.agents.value.some((a) => a.alias === agent);
  useEffect(() => {
    if (isPaired && (step === 'verifying' || step === 'requested')) {
      setStepRaw('success');
      clear(agent);
    }
  }, [isPaired, step, agent]);

  // Verifying state: the server-side `tryPairing` writes paired-users.json
  // and emits `pairingEvents.changed`, which the web transport translates
  // into a fresh `agents` packet pushed down this client's WebSocket. The
  // worker ingests the packet, `store.agents.value` updates, and the
  // `isPaired` useEffect above flips this form to `success`. No polling
  // or timeout fallback — if the push doesn't arrive that's a server bug
  // to fix, not a UX papering-over.
  useEffect(() => {
    if (step !== 'verifying') return;
    const timeout = setTimeout(() => {
      if (step === 'verifying') {
        setStepRaw('failed');
        save(agent, { step: 'failed', code: '' });
        setCodeRaw('');
      }
    }, 15000);
    return () => clearTimeout(timeout);
  }, [step, agent]);

  function handleRequestCode(): void {
    store.sendMessage('/pair');
    setStep('requested');
  }

  function handleSubmitCode(e: Event): void {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    store.sendMessage(`/pair ${trimmed}`);
    setCodeRaw('');
    setStepRaw('verifying');
    save(agent, { step: 'verifying', code: '' });
  }

  function reset(): void {
    setStepRaw('idle');
    setCodeRaw('');
    clear(agent);
  }

  return (
    <div class="flex-1 flex items-center justify-center">
      <div class="w-[420px] bg-gray-900 border border-gray-800 rounded-xl p-8 space-y-6 text-center">
        <div>
          <div class="text-lg font-semibold text-white">{agent}</div>
          <div class="text-sm text-gray-500 mt-1">Pairing required</div>
        </div>

        {step === 'idle' && (
          <div class="space-y-4">
            <p class="text-sm text-gray-400">
              You need to pair with this agent before chatting.
            </p>
            <button
              onClick={handleRequestCode}
              class="w-full px-4 py-2.5 bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Request access
            </button>
            <p class="text-xs text-gray-500">
              The server operator will receive your request and provide a pairing code.
            </p>
          </div>
        )}

        {step === 'requested' && (
          <div class="space-y-4">
            <div class="px-4 py-2.5 bg-blue-900/20 border border-blue-800/30 rounded-lg space-y-1.5">
              <p class="text-sm text-blue-300">
                Access requested. Get your pairing code from the server operator.
              </p>
              <p class="text-xs text-blue-300/60">
                Operator? Your code is waiting in the dashboard: Agents → {agent} → Access → Pairing Codes.
              </p>
            </div>
            <form onSubmit={handleSubmitCode} class="space-y-3">
              <input
                type="text"
                value={code}
                onInput={(e) => setCode((e.target as HTMLInputElement).value)}
                placeholder="000000"
                maxLength={6}
                class="w-full px-4 py-3 bg-gray-950 border border-gray-700 rounded-lg text-lg text-white placeholder-gray-600 focus:border-teal-500 focus:outline-none text-center tracking-[0.3em] mono"
                autoFocus
              />
              <button
                type="submit"
                disabled={!code.trim()}
                class="w-full px-4 py-2.5 bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors"
              >
                Pair
              </button>
            </form>
            <button
              onClick={reset}
              class="text-sm text-gray-500 hover:text-gray-300 transition-colors"
            >
              Start over
            </button>
          </div>
        )}

        {step === 'verifying' && (
          <div class="py-4">
            <div class="flex items-center justify-center gap-3">
              <div class="relative w-5 h-5 flex items-center justify-center">
                <span class="absolute w-2.5 h-2.5 bg-teal-400/60 rounded-full" />
                <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_infinite]" />
                <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_0.6s_infinite]" />
              </div>
              <span class="text-sm text-gray-300">Verifying pairing code...</span>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div class="px-4 py-3 bg-green-900/20 border border-green-800/30 rounded-lg">
            <p class="text-sm font-medium text-green-400">Paired successfully!</p>
          </div>
        )}

        {step === 'failed' && (
          <div class="space-y-4">
            <div class="px-4 py-3 bg-red-900/20 border border-red-800/30 rounded-lg flex items-center justify-center gap-2">
              <svg class="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
              <span class="text-sm font-medium text-red-300">Pairing failed or timed out</span>
            </div>
            <button
              onClick={reset}
              class="px-4 py-2 text-sm font-medium text-gray-300 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg transition-colors"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
