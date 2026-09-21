import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './common/decorators';
import { PrismaService } from './prisma/prisma.service';

/** Used by the hosting platform to decide whether the service is healthy. Reveals nothing sensitive. */
@Public()
@Controller('health')
export class HealthController {
  constructor(private prisma: PrismaService) {}

  @Get()
  async check() {
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { throw new ServiceUnavailableException('database unavailable'); }
    return { status: 'ok' };
  }
}
