/**
 * CONFIG_MANAGER_DESCRIPTOR — code-declared virtual agent at
 * `console:config-manager`.
 *
 * The `console:` namespace is reserved for code-declared virtual agents
 * that act as console access to the server (Config Manager, Design
 * Manager, Security Manager). Config Manager delegates intra-surface
 * into per-agent `__configure` channels.
 */
export const CONFIG_MANAGER_DESCRIPTOR = {
  address: 'console:config-manager',
  label: 'config-manager',
  access: 'local-only',
} as const;

export type ConsoleDescriptor = typeof CONFIG_MANAGER_DESCRIPTOR;
