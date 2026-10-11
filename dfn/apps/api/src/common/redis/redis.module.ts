import { Global, Module } from '@nestjs/common';
import { RedisConnectionService } from './redis-connection.service';

/**
 * Redis connection lifecycle. Global: imported by JobsModule (BullMQ driver) and by the
 * ThrottlerModule configuration; ApiAuthService (Redis rate limits) resolves it from anywhere.
 * Connections are opened lazily, only by the features configured to use Redis.
 */
@Global()
@Module({ providers: [RedisConnectionService], exports: [RedisConnectionService] })
export class RedisModule {}
