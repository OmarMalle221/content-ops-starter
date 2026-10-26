import { serveHandler } from '../_shared/deno-server.ts';
import { handleNotifySupport } from '../_shared/handlers.ts';

serveHandler(handleNotifySupport, { email: true });
