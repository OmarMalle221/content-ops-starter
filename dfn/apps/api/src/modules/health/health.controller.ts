import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ManagedKeysService } from '../keys/managed-keys.service';

@ApiTags('health')
@Controller('v1/health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly managedKeys: ManagedKeysService,
  ) {}

  @Public()
  @Get()
  async health() {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    // KMS-managed data keys of this replica: counts only (the endpoint is public, key ids and
    // purposes stay in the admin console and the logs). A key that cannot be unwrapped, or a
    // refresh that failed as a whole, degrades the status without failing the container health
    // check: the keys already loaded keep working (ADR-0014).
    const keys = this.managedKeys.state;
    const managedKeys = {
      loaded: keys.loaded,
      failing: keys.failures.length,
      refreshError: keys.error !== null,
      lastRefreshAt: keys.lastRefreshAt?.toISOString() ?? null,
    };
    const keysOk = managedKeys.failing === 0 && !managedKeys.refreshError;
    return {
      status: database === 'ok' && keysOk ? 'ok' : 'degraded',
      mode: 'sandbox',
      database,
      managedKeys,
      time: new Date().toISOString(),
    };
  }
}
