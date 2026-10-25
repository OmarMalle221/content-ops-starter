import { serveHandler } from '../_shared/deno-server.ts';
import { handleDeleteDocument } from '../_shared/handlers.ts';

serveHandler(handleDeleteDocument);
