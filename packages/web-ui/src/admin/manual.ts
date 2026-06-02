/**
 * Admin page manual registry.
 *
 * Each admin page colocates a `pageManual` export next to its component; this
 * module imports them and assembles the route-keyed registry consumed by
 * `admin__navigate`. Missing an export here means a page is invisible to the
 * bot — drift protection comes from TS type-checking (missing import = build
 * error).
 *
 * Keys are wouter path patterns — they must match the routes declared in
 * `packages/web-ui/src/admin/router.tsx`. For tabbed pages, the `agent-detail`
 * file owns one entry per distinct tab path.
 */
import type { AdminManual } from '@getcast/admin-schema/v1';

import { pageManual as overviewManual } from './pages/overview';
import { pageManual as idpManual } from './pages/idp';
import { pageManual as routesManual } from './pages/routes';
import { pageManual as settingsManual } from './pages/settings';
import { pageManual as activityManual } from './pages/activity';
import { pageManual as agentsListManual } from './pages/agents-list';

import {
  agentOverviewManual,
  agentBlueprintManual,
  agentSettingsManual,
  agentAccessManual,
  agentCapabilitiesManual,
  agentActivityManual,
} from './pages/agent-detail';

import { pageManual as emailManual } from './pages/extensions/email';
import { pageManual as webFetchManual } from './pages/extensions/web-fetch';
import { pageManual as calendarManual } from './pages/extensions/calendar';
import { pageManual as whatsappManual } from './pages/extensions/whatsapp';

export const ADMIN_MANUAL: AdminManual = {
  // Server-level pages
  '/': overviewManual,
  '/identity': idpManual,
  '/routes': routesManual,
  '/activity': activityManual,
  '/settings': settingsManual,

  // Fleet
  '/agents': agentsListManual,

  // Per-agent tabs — six tabs (overview / blueprint / settings / access /
  // capabilities / activity). Old URLs redirect client-side; we don't
  // register entries for them since the bot should learn the new vocabulary.
  '/agents/:alias': agentOverviewManual,
  '/agents/:alias/blueprint': agentBlueprintManual,
  '/agents/:alias/settings': agentSettingsManual,
  '/agents/:alias/access': agentAccessManual,
  '/agents/:alias/capabilities': agentCapabilitiesManual,
  '/agents/:alias/capabilities/extensions': agentCapabilitiesManual,
  '/agents/:alias/capabilities/mcp-servers': agentCapabilitiesManual,
  '/agents/:alias/activity': agentActivityManual,

  // Per-extension drill-in — sits under the Extensions subtab of Capabilities.
  '/agents/:alias/capabilities/extensions/email': emailManual,
  '/agents/:alias/capabilities/extensions/web-fetch': webFetchManual,
  '/agents/:alias/capabilities/extensions/calendar': calendarManual,
  '/agents/:alias/capabilities/extensions/whatsapp': whatsappManual,
};
