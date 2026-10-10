import 'server-only';
import { notFound } from 'next/navigation';
import type { Actor } from '@/server/auth/actor';
import { isAppError } from '@/server/errors';
import { getApp } from '@/server/instance';
import type { TransactionView } from '@/lib/dto';

/** Loads a transaction view; any authorisation failure renders a 404 (no existence leak). */
export async function loadTransactionView(actor: Actor, id: string, withComparison: boolean): Promise<TransactionView> {
    const app = await getApp();
    try {
        const view = await app.views.transaction(actor, id);
        if (withComparison) view.comparison = (await app.views.comparison(actor, id)).rows;
        return view;
    } catch (error) {
        if (isAppError(error) && (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN')) notFound();
        throw error;
    }
}
