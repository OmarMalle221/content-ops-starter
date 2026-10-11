import 'reflect-metadata';
import { installBigIntJson } from '../src/common/serialize';

installBigIntJson();
process.env.DFN_MODE = 'sandbox';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://postgres@127.0.0.1:54329/dfn_test?schema=public';
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? 'test-session-secret-not-for-production-use';
process.env.DOCUMENT_ENCRYPTION_KEY = process.env.DOCUMENT_ENCRYPTION_KEY ?? '1'.repeat(64);
process.env.STORAGE_DIR = process.env.STORAGE_DIR ?? '/tmp/dfn-test-storage';
process.env.REDIS_URL = '';
process.env.LOG_LEVEL = 'silent';
