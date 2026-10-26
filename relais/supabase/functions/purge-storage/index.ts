import { serveScheduled } from '../_shared/deno-server.ts';
import { handlePurgeStorage } from '../_shared/storage-purge.ts';

serveScheduled(handlePurgeStorage);
