import { serveHandler } from '../_shared/deno-server.ts';
import { handleDocumentUrl } from '../_shared/handlers.ts';

serveHandler(handleDocumentUrl);
