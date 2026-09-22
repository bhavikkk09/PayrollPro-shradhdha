import { Controller, Get, Injectable, Logger, OnModuleDestroy, OnModuleInit, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AuthUser } from '../common/auth.types';
import { CurrentUser, InternalOnly, RequirePermissions } from '../common/decorators';
import { NotificationsService } from './notifications.service';

class ListQuery {
  @IsOptional() @Transform(({ value }) => value === 'true') @IsBoolean() unread?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize = 20;
}

/** Every route returns only the caller's own notifications. */
@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private svc: NotificationsService) {}

  @Get() list(@CurrentUser() u: AuthUser, @Query() q: ListQuery) { return this.svc.list(u, q); }
  @Get('unread-count') unread(@CurrentUser() u: AuthUser) { return this.svc.unreadCount(u); }
  @Post('read-all') readAll(@CurrentUser() u: AuthUser) { return this.svc.markAllRead(u); }
  @Post(':id/read') read(@CurrentUser() u: AuthUser, @Param('id') id: string) { return this.svc.markRead(u, id); }

  /** Runs the scheduled checks now (also runs automatically). */
  @InternalOnly() @RequirePermissions('settings.manage') @Post('sweep')
  sweep() { return this.svc.sweep(); }
}

/**
 * In-process timer: first run shortly after start, then every 6 hours. Overlapping runs from several servers are safe
 * because every notification carries a unique dedupe key. Production deployments should also trigger POST /notifications/sweep
 * from a real scheduler, since free hosts sleep when idle.
 */
@Injectable()
export class NotificationsScheduler implements OnModuleInit, OnModuleDestroy {
  private log = new Logger('Scheduler');
  private timers: NodeJS.Timeout[] = [];
  constructor(private svc: NotificationsService) {}

  onModuleInit() {
    if (process.env.DISABLE_SCHEDULER === 'true' || process.env.NODE_ENV === 'test') return;
    const run = () => this.svc.sweep().then((r) => this.log.log(`sweep: ${JSON.stringify(r)}`)).catch((e) => this.log.error(`sweep failed: ${e?.message ?? e}`));
    const first = setTimeout(run, 60_000);
    const every = setInterval(run, 6 * 3600_000);
    first.unref(); every.unref();
    this.timers.push(first, every);
  }
  onModuleDestroy() { this.timers.forEach(clearTimeout); }
}
