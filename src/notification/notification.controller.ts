import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { NotificationService } from './notification.service';
import { ListNotificationsDto } from './dto/list-notifications.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

type RequestUser = { id: string; role: UserRole };

@ApiTags('notification')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard)
@Controller('notifications')
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get()
  @ApiOperation({ summary: 'List my notifications (newest first)' })
  @ApiResponse({
    status: 200,
    description: 'Returns notifications with workspace',
  })
  list(@Req() req: Request, @Query() query: ListNotificationsDto) {
    const user = req.user as RequestUser;
    return this.notificationService.list(user.id, query);
  }

  @Get('unread-count')
  @ApiOperation({ summary: 'Count my unread notifications' })
  @ApiResponse({ status: 200, description: 'Returns { count }' })
  unreadCount(@Req() req: Request) {
    const user = req.user as RequestUser;
    return this.notificationService.unreadCount(user.id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all my notifications as read' })
  @ApiResponse({ status: 200, description: 'Returns { updated }' })
  markAllRead(@Req() req: Request) {
    const user = req.user as RequestUser;
    return this.notificationService.markAllRead(user.id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark one notification as read' })
  @ApiResponse({ status: 200, description: 'Notification marked read' })
  markRead(@Req() req: Request, @Param('id') id: string) {
    const user = req.user as RequestUser;
    return this.notificationService.markRead(user.id, id);
  }
}
