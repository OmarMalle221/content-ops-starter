import { apiRoute, json, readJson } from '@/server/http/api';

/** Buyer decision. Approval creates an authorised release instruction — never a direct payout. */
export const POST = apiRoute<{ id: string; milestoneId: string }>(async ({ req, app, actor, params }) => {
    const r = await app.milestones.review(actor, params.id, params.milestoneId, await readJson(req));
    return json({ data: { status: r.transaction.status, releaseBlockers: r.releaseBlockers } });
});
