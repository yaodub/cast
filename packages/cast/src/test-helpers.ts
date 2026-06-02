/**
 * Shared test fixtures — testCtx / testDeps / testStubStore.
 *
 * Consolidates per-file mock factories that had drifted: `mcp-server.test.ts`,
 * `console-configure-tools.test.ts`, `agent-manager-invariants.test.ts` each
 * built their own context shapes by hand. When a context field was added to
 * production code, factories diverged silently.
 *
 * Use these for any new test that needs an `McpAgentContext`, `McpServerDeps`,
 * or a stub `AgentStateStore`. Override only the fields the test cares about
 * via the `overrides` arg.
 */
import type { AgentStateStore } from './agent/state-store.js';
import type { McpAgentContext, McpServerDeps } from './agent/mcp-server.js';

/** Minimal stub store — every method is a noop or returns empty. Override per-test as needed. */
export function makeStubStore(overrides?: Partial<AgentStateStore>): AgentStateStore {
  const base = {
    createTask: () => {},
    getTaskById: () => undefined,
    getAllTasks: () => [],
    getTasksForAddress: () => [],
    updateTask: () => {},
    deleteTask: () => {},
    getDueTasksForAgent: () => [],
    recoverStuckTasks: () => 0,
    updateTaskAfterRun: () => {},
    logTaskRun: () => {},
    getRecentTaskRuns: () => [],
    getActiveConversation: () => undefined,
    upsertConversation: () => ({}) as never,
    touchConversation: () => {},
    expireConversation: () => {},
    updateCcSessionId: () => {},
    updateSummary: () => {},
    getActiveConversations: () => [],
    getPreviousSessions: () => [],
    getConversationsWithSummaries: () => [],
    flush: () => {},
    ...overrides,
  };
  return base as unknown as AgentStateStore;
}

/** Default test context for MCP tool tests. Override per-test. */
export function makeTestCtx(overrides?: Partial<McpAgentContext>): McpAgentContext {
  return {
    agentFolder: 'test',
    agentId: 'a:test@srv',
    participant: 'cli:user',
    channelName: 'default',
    store: makeStubStore(),
    ...overrides,
  };
}

/** Default test deps for MCP tool tests. Override per-test. */
export function makeTestDeps(overrides?: Partial<McpServerDeps>): McpServerDeps {
  return { ...overrides };
}
