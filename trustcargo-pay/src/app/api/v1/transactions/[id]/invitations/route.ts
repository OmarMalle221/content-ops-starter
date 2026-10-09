import { apiRoute, json } from '@/server/http/api';

/** Issues invitation links. They are returned once and never stored in clear. */
export const POST = apiRoute<{ id: string }>(async ({ app, actor, params }) => {
    const r = await app.transactions.sendInvitations(actor, params.id);
    return json({ data: { status: r.transaction.status, links: r.links } }, 201);
});
