import type { CalendarProviderId } from '../../db/schema';
import { NotImplemented, type CalendarProvider } from '../provider';

/** An adapter whose methods aren't written yet: every call throws NotImplemented. */
export function stubProvider(id: CalendarProviderId): CalendarProvider {
  const todo = (method: string) => () => {
    throw new NotImplemented(`${id}.${method}`);
  };
  return {
    id,
    capabilities: { webhooks: false, pushTasks: false, editEvents: false },
    authUrl: todo('authUrl'),
    exchangeCode: todo('exchangeCode'),
    accessToken: todo('accessToken'),
    revoke: todo('revoke'),
    listCalendars: todo('listCalendars'),
    syncEvents: todo('syncEvents'),
    subscribe: todo('subscribe'),
    renew: todo('renew'),
    unsubscribe: todo('unsubscribe'),
    parseWebhook: () => ({ kind: 'invalid' }),
    createOwnCalendar: todo('createOwnCalendar'),
    createEvent: todo('createEvent'),
    updateEvent: todo('updateEvent'),
    deleteEvent: todo('deleteEvent'),
  };
}
