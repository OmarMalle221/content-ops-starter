import { serveHandler } from '../_shared/deno-server.ts';
import { handleExplainProgram } from '../_shared/handlers.ts';

serveHandler(handleExplainProgram, { llm: true });
