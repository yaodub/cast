/**
 * DESIGN_MANAGER_DESCRIPTOR — code-declared virtual service at
 * `console:design-manager`.
 *
 * Second entry in the `console:` namespace after Config Manager. Same three-field
 * shape; when the namespace grows past two with differing ACL posture,
 * extract `lookupConsoleDescriptor(addr)` behind a `Map<string,
 * ConsoleDescriptor>`.
 */
export const DESIGN_MANAGER_DESCRIPTOR = {
  address: 'console:design-manager',
  label: 'design-manager',
  access: 'local-only',
} as const;

export type DesignManagerDescriptor = typeof DESIGN_MANAGER_DESCRIPTOR;
