import { serveHandler } from '../_shared/deno-server.ts';
import { handleDeleteCareFile } from '../_shared/handlers.ts';

serveHandler(handleDeleteCareFile);
