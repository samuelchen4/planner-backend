import { stubProvider } from '../stub';

// Microsoft Graph (Outlook / Microsoft 365) adapter: step 8 of the plan, after Google ships.
// Same files as the Google adapter; calendarView/delta needs a date window, and Graph
// subscriptions need the validationToken handshake.
export const microsoft = stubProvider('microsoft');
