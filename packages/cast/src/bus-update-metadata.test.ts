/**
 * Tests for `Bus.updateMetadata` — the in-place metadata merge used to push a
 * description edit to metadata readers (roster, peer lists, admin UI) without
 * an unregister/re-register cycle.
 */
import { describe, it, expect } from 'vitest';

import { Bus, type BusHandler, type BusLifecycleEvent } from './gateway/bus.js';

const stubHandler: BusHandler = {
  handleMessage: async () => {},
  handleEvent: async () => {},
};

const KEY = 'a:test@d9c1e2';

function registered(): Bus {
  const bus = new Bus();
  bus.register(KEY, stubHandler, 'exact', { label: 'test', type: 'agent', folderPath: 'test' });
  return bus;
}

describe('Bus.updateMetadata', () => {
  it('merges new fields into getMetadata and listEntities', () => {
    const bus = registered();
    bus.updateMetadata(KEY, { description: 'Triages inbound mail' }, 'description-changed');

    expect(bus.getMetadata(KEY)?.description).toBe('Triages inbound mail');
    const entity = bus.listEntities({ type: 'agent' }).find((e) => e.id === KEY);
    expect(entity?.description).toBe('Triages inbound mail');
    // Identity-bearing fields are left untouched by the merge.
    expect(bus.getMetadata(KEY)?.label).toBe('test');
    expect(bus.getMetadata(KEY)?.folderPath).toBe('test');
  });

  it('emits an updated lifecycle event carrying the cause', () => {
    const bus = registered();
    const events: BusLifecycleEvent[] = [];
    bus.onLifecycle((e) => events.push(e));

    bus.updateMetadata(KEY, { description: 'x' }, 'description-changed');

    expect(events).toEqual([{ type: 'updated', address: KEY, cause: 'description-changed' }]);
  });

  it('is a no-op (no event) when the merge would change nothing', () => {
    const bus = registered();
    bus.updateMetadata(KEY, { description: 'Triages inbound mail' }, 'description-changed');
    const events: BusLifecycleEvent[] = [];
    bus.onLifecycle((e) => events.push(e));

    // Same value again — e.g. the file watcher re-firing after the in-band
    // Design tool already pushed it. Must not emit a redundant lifecycle event.
    bus.updateMetadata(KEY, { description: 'Triages inbound mail' }, 'description-changed');

    expect(events).toHaveLength(0);
    expect(bus.getMetadata(KEY)?.description).toBe('Triages inbound mail');
  });

  it('is a no-op (no write, no event) when the key has no registered metadata', () => {
    const bus = new Bus();
    const events: BusLifecycleEvent[] = [];
    bus.onLifecycle((e) => events.push(e));

    bus.updateMetadata('a:ghost@0000', { description: 'x' }, 'description-changed');

    expect(bus.getMetadata('a:ghost@0000')).toBeUndefined();
    expect(events).toHaveLength(0);
  });
});
