/**
 * File storage selection (documents). Only this module knows which adapter backs `FileStorage`.
 */
import type { ServerConfig } from '@/server/config';
import type { FileStorage } from '@/server/ports/providers';
import { MemoryFileStorage } from './mock/mock-providers';

export function createFileStorage(config: ServerConfig): FileStorage {
    if (config.storage.provider === 'supabase') {
        throw new Error('The Supabase Storage adapter is not wired yet');
    }
    return new MemoryFileStorage();
}
