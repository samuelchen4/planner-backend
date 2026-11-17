import { CALENDAR_PROVIDERS, type CalendarProviderId } from '../db/schema';
import { google } from './adapters/google';
import { microsoft } from './adapters/microsoft';
import type { CalendarProvider } from './provider';

const builtIn: Record<CalendarProviderId, CalendarProvider> = { google, microsoft };
let overrides: Partial<Record<CalendarProviderId, CalendarProvider>> = {};

export function providerFor(id: CalendarProviderId): CalendarProvider {
  return overrides[id] ?? builtIn[id];
}

export function isProviderId(id: string): id is CalendarProviderId {
  return (CALENDAR_PROVIDERS as readonly string[]).includes(id);
}

/** Tests: swap a provider for a fake (see testing/fake-provider.ts). */
export function overrideProvider(id: CalendarProviderId, provider: CalendarProvider | null) {
  if (provider) overrides[id] = provider;
  else delete overrides[id];
}

export function resetProviders() {
  overrides = {};
}
