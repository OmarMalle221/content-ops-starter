import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';

@ApiTags('health')
@Controller('v1/health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      mode: 'sandbox',
      database,
      time: new Date().toISOString(),
    };
  }
}
