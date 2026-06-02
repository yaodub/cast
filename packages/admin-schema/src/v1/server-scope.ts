/**
 * Server-scope console targets — Design Manager, Config Manager, Security
 * Manager live at `console:<name>` bus addresses and surface as drawer tabs
 * in the admin UI.
 *
 * The enum is the vocabulary cast emits via `show.target` when it wants the
 * operator's attention on a manager drawer. The admin UI checks
 * `isServerScopeTarget(target)` to decide drawer-tab-switch vs router push;
 * cast does not classify.
 */

export const SERVER_SCOPE_TARGETS = ['config-manager', 'design-manager', 'security-manager'] as const;

export type ServerScopeTarget = (typeof SERVER_SCOPE_TARGETS)[number];

export function isServerScopeTarget(value: string): value is ServerScopeTarget {
  return (SERVER_SCOPE_TARGETS as readonly string[]).includes(value);
}
