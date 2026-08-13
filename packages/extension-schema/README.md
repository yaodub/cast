# @getcast/extension-schema

The contract between a [Cast](https://github.com/yaodub/cast) extension and its host.

An extension is a capability unit that connects to an outside service — a mailbox, a calendar, a
messaging account — and exposes it to an agent as tools. This package defines the types both sides
agree on: what a tool looks like, what the host injects into an extension, what an extension hands
back. Extensions import from here and never from server internals, which is what keeps them
substitutable.

It is deliberately tiny: one file, no runtime dependencies. `zod` is a peer dependency used only in
type position, so it disappears at compile time.

```
npm install @getcast/extension-schema zod
```

## Status

**0.x, and the surface will change.** The one part known to be missing is a way for an extension to
contribute its own admin UI; today that lives in the host application, so an extension is not yet a
fully self-contained unit.

Extensions are currently authored *inside* the Cast monorepo, as packages under `packages/ext-*`, and
registered with an explicit `registerExtension()` call at server startup. **There is no loader for
out-of-tree extensions yet** — installing this package lets you compile against the contract, but a
Cast server has no way to discover an extension that lives outside its repo. If that is what you came
for, it does not work yet.

This package is published so the contract has a stable identity and a real install path ahead of that
work, and so the packaging is proven before anything depends on it.

## Shape

```ts
import { defineExtension, textResult } from '@getcast/extension-schema';
import { z } from 'zod';

export const clock = defineExtension({
  name: 'clock',
  configSchema: z.object({ timezone: z.string().default('UTC') }),
  secretsSchema: z.object({}),
  create: (ctx) => ({
    name: 'clock',
    tools: [{
      name: 'clock__now',
      description: 'Return the current time.',
      schema: {},
    }],
    handle: async () =>
      textResult(new Date().toLocaleString('en-US', { timeZone: ctx.config.timezone })),
  }),
});
```

`create()` is called once per agent that enables the extension. `ctx` carries validated config and
secrets, a private runtime directory, a shared directory the agent can read, a `deliver()` callback for
pushing messages to the agent, and a logger.

Tools may declare an `approval` block, in which case the host wraps the handler in its approval flow and
the extension supplies the human-readable preview. Config is merged locked-by-default: values an author
writes are fixed unless marked `{ unlocked: true, value }`, which is what lets an operator tune a
setting the author chose to expose.

## Authoring

[AUTHORING.md](https://github.com/yaodub/cast/blob/main/packages/extension-schema/AUTHORING.md) is the
full guide — package layout, config and secrets, the approval flow, service hosts, and the reply
binding rules for extensions that deliver messages asynchronously. It assumes the in-monorepo workflow
described above.

## License

MIT
