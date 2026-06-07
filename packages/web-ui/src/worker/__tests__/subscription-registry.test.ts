/**
 * SubscriptionRegistry — coverage for the per-(port, scope) idempotency
 * semantics that gate the worker's connection refcount. The test surface
 * mirrors the bug fix: tabs frequently subscribe to the same
 * scope from multiple hooks, so `add` must distinguish first-time from
 * repeat so handleSubscribe only acquires once per port-scope pair.
 */
import { describe, expect, it } from 'vitest';

import type { TabChannel } from '../interfaces';
import { SubscriptionRegistry } from '../subscription-registry';
import type { Scope } from '../protocol';

function fakePort(): TabChannel {
  return {
    postMessage: () => {},
    onMessage: () => () => {},
    onClose: () => () => {},
    close: () => {},
  };
}

const adminGlobal: Scope = { kind: 'admin-global' };
const adminTargetA: Scope = {
  kind: 'admin-target',
  target: { kind: 'agent', alias: 'a', channel: '__design' },
};
const adminTargetB: Scope = {
  kind: 'admin-target',
  target: { kind: 'agent', alias: 'b', channel: '__configure' },
};

describe('SubscriptionRegistry', () => {
  it('returns isNew=true on first add for a (port, scope) pair', () => {
    const reg = new SubscriptionRegistry();
    const port = fakePort();
    const { isNew } = reg.add(port, adminGlobal);
    expect(isNew).toBe(true);
    expect(reg.countForScopeKey('admin-global')).toBe(1);
  });

  it('returns isNew=false on repeat add — same port, same scope', () => {
    const reg = new SubscriptionRegistry();
    const port = fakePort();
    reg.add(port, adminGlobal);
    const { isNew } = reg.add(port, adminGlobal);
    expect(isNew).toBe(false);
    expect(reg.countForScopeKey('admin-global')).toBe(1);
  });

  it('returns isNew=true for the same scope from a different port', () => {
    const reg = new SubscriptionRegistry();
    const portA = fakePort();
    const portB = fakePort();
    reg.add(portA, adminTargetA);
    const { isNew } = reg.add(portB, adminTargetA);
    expect(isNew).toBe(true);
    expect(reg.countForScopeKey('admin-target:agent:a:__design')).toBe(2);
  });

  it('removeByPortAndScope removes the matching sub and returns it', () => {
    const reg = new SubscriptionRegistry();
    const port = fakePort();
    reg.add(port, adminTargetA);
    const removed = reg.removeByPortAndScope(port, adminTargetA);
    expect(removed?.scope).toEqual(adminTargetA);
    expect(reg.countForScopeKey('admin-target:agent:a:__design')).toBe(0);
  });

  it('removeByPortAndScope returns null when the pair is not registered', () => {
    const reg = new SubscriptionRegistry();
    const port = fakePort();
    expect(reg.removeByPortAndScope(port, adminTargetA)).toBeNull();
  });

  it('removeAllByPort drops every sub for a port and returns them', () => {
    const reg = new SubscriptionRegistry();
    const port = fakePort();
    reg.add(port, adminGlobal);
    reg.add(port, adminTargetA);
    reg.add(port, adminTargetB);
    const removed = reg.removeAllByPort(port);
    expect(removed).toHaveLength(3);
    expect(reg.countForScopeKey('admin-global')).toBe(0);
    expect(reg.countForScopeKey('admin-target:agent:a:__design')).toBe(0);
    expect(reg.countForScopeKey('admin-target:agent:b:__configure')).toBe(0);
  });

  it('forScopeKey iterates only matching subs across ports', () => {
    const reg = new SubscriptionRegistry();
    const portA = fakePort();
    const portB = fakePort();
    reg.add(portA, adminTargetA);
    reg.add(portB, adminTargetA);
    reg.add(portA, adminTargetB);
    const subs = Array.from(reg.forScopeKey('admin-target:agent:a:__design'));
    expect(subs).toHaveLength(2);
  });

  it('allPorts returns each unique port once across many subs', () => {
    const reg = new SubscriptionRegistry();
    const portA = fakePort();
    const portB = fakePort();
    reg.add(portA, adminGlobal);
    reg.add(portA, adminTargetA);
    reg.add(portB, adminTargetA);
    const ports = Array.from(reg.allPorts());
    expect(new Set(ports).size).toBe(2);
  });
});
