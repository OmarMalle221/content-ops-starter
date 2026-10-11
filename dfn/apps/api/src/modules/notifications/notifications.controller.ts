import { Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { paginationSchema } from '@dfn/shared';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthContext } from '../../common/auth-context';
import { zodBody } from '../../common/pipes/zod-validation.pipe';
import { NotificationsService } from './notifications.service';

@ApiTags('notifications')
@Controller('v1/notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() auth: AuthContext,
    @Query(zodBody(paginationSchema)) q: { page: number; pageSize: number },
    @Query('unread') unread?: string,
  ) {
    return this.notifications.listForUser(auth.userId, q.page, q.pageSize, unread === 'true');
  }

  @Post(':id/read')
  markRead(@CurrentUser() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead(auth.userId, id);
  }

  @Post('read-all')
  markAll(@CurrentUser() auth: AuthContext) {
    return this.notifications.markAllRead(auth.userId);
  }
}
