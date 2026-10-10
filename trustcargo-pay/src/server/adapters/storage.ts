/**
 * File storage selection (documents). Only this module knows which adapter backs `FileStorage`.
 */
import type { ServerConfig } from '@/server/config';
import type { FileStorage } from '@/server/ports/providers';
import { MemoryFileStorage } from './mock/mock-providers';
import { SupabaseFileStorage } from './supabase/supabase-storage';

export function createFileStorage(config: ServerConfig): FileStorage {
    if (config.storage.provider === 'supabase') {
        // loadConfig already refuses STORAGE_PROVIDER=supabase without SUPABASE_URL and SUPABASE_SECRET_KEY.
        if (!config.supabase?.secretKey) throw new Error('STORAGE_PROVIDER=supabase requires SUPABASE_URL and SUPABASE_SECRET_KEY');
        return new SupabaseFileStorage({ url: config.supabase.url, secretKey: config.supabase.secretKey, bucket: config.storage.bucket });
    }
    return new MemoryFileStorage();
}
