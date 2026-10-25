import { z } from 'zod';

const EnvSchema = z.object({
    VITE_SUPABASE_URL: z.url(),
    VITE_SUPABASE_ANON_KEY: z.string().min(1)
});

export type Env = z.infer<typeof EnvSchema>;

/** Variables publiques du client. La clé « anon » n'est pas un secret : la sécurité repose sur RLS. */
export function readEnv(source: Record<string, unknown> = import.meta.env): Env {
    const parsed = EnvSchema.safeParse(source);
    if (!parsed.success) {
        throw new Error('Configuration manquante : VITE_SUPABASE_URL et VITE_SUPABASE_ANON_KEY (voir .env.example).');
    }
    return parsed.data;
}
