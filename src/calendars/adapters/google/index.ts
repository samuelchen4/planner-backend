import { stubProvider } from '../stub';

// Google Calendar API adapter. Built in steps 3–6 of the plan: oauth.ts (consent, code exchange,
// refresh, revoke), api.ts (fetch client), mapping.ts (Google event ⇄ ProviderEvent), then this
// file wires them into a CalendarProvider.
export const google = stubProvider('google');
