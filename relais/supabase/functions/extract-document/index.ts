import { serveHandler } from '../_shared/deno-server.ts';
import { handleExtractDocument } from '../_shared/handlers.ts';

serveHandler(handleExtractDocument, { llm: true });
