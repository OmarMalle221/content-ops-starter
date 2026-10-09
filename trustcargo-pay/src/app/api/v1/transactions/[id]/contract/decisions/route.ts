import { apiRoute, json, readJson } from '@/server/http/api';

export const POST = apiRoute<{ id: string }>(async ({ req, app, actor, params }) => {
    const tx = await app.transactions.decideContract(actor, params.id, await readJson(req));
    return json({ data: { status: tx.status } }, 201);
});
