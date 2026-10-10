/** Result of a server action, rendered by <ActionForm>. Never contains stack traces or secrets. */
export interface ActionError {
    code: string;
    message?: string;
    failedGuards?: string[];
    blockers?: string[];
    fields?: string[];
}

export interface ActionState<T = unknown> {
    ok?: boolean;
    error?: ActionError;
    data?: T;
    /** Changes on every completion so the UI can react to repeated identical results. */
    at?: number;
}

export const initialActionState: ActionState = {};
