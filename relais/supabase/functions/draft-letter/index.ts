import { serveHandler } from '../_shared/deno-server.ts';
import { handleDraftLetter } from '../_shared/handlers.ts';

serveHandler(handleDraftLetter, { llm: true });
