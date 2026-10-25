import { serveScheduled } from '../_shared/deno-server.ts';
import { handleSendReminders } from '../_shared/reminders.ts';

serveScheduled(handleSendReminders);
