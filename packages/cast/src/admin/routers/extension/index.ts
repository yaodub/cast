/**
 * Extension meta-router — namespaces per-extension sub-routers.
 *
 * Each extension gets its own sub-router under `extension.<name>`.
 * Extensions that need OAuth export a plain Express router alongside
 * the tRPC router (tRPC can't do HTTP redirects).
 *
 * Client usage: trpc.extension.email.getConfig.useQuery({ folder })
 */
import { Router } from 'express';
import { router } from '../../trpc.js';
import type { Bus } from '../../../gateway/bus.js';

import { emailRouter } from './email.js';
import { webFetchRouter } from './web-fetch.js';
import { calendarRouter, createCalendarOAuthRouter } from './calendar.js';
import { whatsappRouter } from './whatsapp.js';
import { sharedRouter } from './helpers.js';

import type { Router as RouterType } from 'express';

export const extensionRouter = router({
  email: emailRouter,
  webFetch: webFetchRouter,
  calendar: calendarRouter,
  whatsapp: whatsappRouter,
  shared: sharedRouter,
});

/** Collect OAuth redirect routes from all extensions that need them. */
export function createExtensionOAuthRouter(deps: { bus: Bus }): RouterType {
  const oauthRouter = Router();
  oauthRouter.use(createCalendarOAuthRouter(deps));
  return oauthRouter;
}
