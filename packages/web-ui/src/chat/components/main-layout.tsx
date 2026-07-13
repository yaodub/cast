import { Sidebar } from './sidebar';
import { ChatArea } from './chat-area';
import * as store from '../lib/store';
import { getActiveHandle } from '../../lib/identity';

export function MainLayout() {
  const agent = store.activeAgent.value;
  const agentData = store.agents.value.find((a) => a.alias === agent);
  // A granted agent carries its real channel set; an ungranted one (still in
  // the directory, no grant yet) gets a plain default-channel chat. You just
  // type — there is no "request access" step. An ungranted first message is
  // held and the system replies that approval is pending; on grant your real
  // message replays and the agent answers it. Once granted, `agentData`
  // appears and its real channels take over.
  const channels = agentData?.channels ?? [{ name: 'default', bits: '' }];

  return (
    // Frame layout — root holds the sidebar's deep-teal color and main
    // sits inset by 8px on top + left so a frame strip shows through.
    // `rounded-tl-xl` on main echoes the visual language of the admin
    // shell — separate products, shared workspace-card idiom.
    <div class="flex h-screen bg-[#0a1a1f]">
      <Sidebar />
      <main class="flex-1 flex flex-col min-w-0 mt-2 ml-2 rounded-tl-xl bg-gray-950 overflow-hidden">
        {!agent && (
          <div class="flex-1 flex items-center justify-center">
            <div class="text-center space-y-4">
              <svg class="w-12 h-12 text-gray-700 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <div>
                <div class="text-gray-300 font-medium">Select a conversation</div>
                <div class="text-sm text-gray-500 mt-1">Pick an agent from the sidebar to start chatting</div>
              </div>
            </div>
          </div>
        )}
        {agent && (
          <ChatArea
            messages={store.messages.value}
            activeAgent={store.activeAgent.value}
            activeChannel={store.activeChannel.value}
            channels={channels}
            error={store.error.value}
            typing={store.typing.value}
            lifecycle={store.lifecycle.value}
            previews={store.previews.value}
            pendingFiles={store.pendingFiles.value}
            currentHandle={getActiveHandle()}
            onSend={store.sendMessage}
            onStageFiles={store.stageFiles}
            onUnstageFile={store.unstageFile}
            onChannelChange={(ch) => store.navigateTo(agent, ch)}
          />
        )}
      </main>
    </div>
  );
}
