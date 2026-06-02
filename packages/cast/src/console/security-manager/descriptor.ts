/**
 * SECURITY_MANAGER_DESCRIPTOR — code-declared virtual console at
 * `console:security-manager`.
 *
 * The `console:` namespace is reserved for code-declared virtual agents that
 * act as console access to the server. SM is the third such console (after
 * Config Manager and Design Manager). Surface is sdk-only — SM sees PII
 * (blueprints, ACL, credential metadata via blueprint/config) and cannot
 * exfiltrate.
 */
export const SECURITY_MANAGER_DESCRIPTOR = {
  address: 'console:security-manager',
  label: 'security-manager',
  access: 'local-only',
} as const;

export type SecurityManagerDescriptor = typeof SECURITY_MANAGER_DESCRIPTOR;
