import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { MessageService } from './message.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserStatus } from '@prisma/client';
import { rejectExpiredSocket } from '../libs/common/utils/socket-auth';
import { SendMessageDto } from './dto/send-message.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { LoadMoreMessagesDto } from './dto/load-more.dto';
import { PresenceService } from '../presence/presence.service';
import { NotificationService } from '../notification/notification.service';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  tokenExpiresAt?: number;
}

@WebSocketGateway({
  cors: { origin: process.env.ALLOWED_ORIGIN, credentials: true },
  namespace: '/chat',
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class MessageGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MessageGateway.name);

  constructor(
    private readonly messageService: MessageService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
    private readonly presenceService: PresenceService,
    private readonly notificationService: NotificationService,
  ) {}

  async handleConnection(client: AuthenticatedSocket) {
    const token = client.handshake.auth?.token as string | undefined;

    if (!token) {
      client.disconnect();
      return;
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });

      if (!payload.userId || payload.isTwoFactorAuthenticated === false) {
        client.disconnect();
        return;
      }

      const user = await this.prismaService.user.findUnique({
        where: { id: payload.userId },
        select: { status: true },
      });
      if (!user || user.status !== UserStatus.ACTIVE) {
        client.disconnect();
        return;
      }

      client.userId = payload.userId;
      client.userEmail = payload.email;
      // Record exp so handlers can drop the socket once the access token
      // expires — verifying the JWT only at connect time isn't enough
      // when the socket lives for hours.
      client.tokenExpiresAt = payload.exp;
      // The frontend keeps a /chat socket open whenever the user is logged in,
      // so this doubles as app-wide presence used by notifications.
      this.presenceService.add(client.userId, client.id);
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    if (client.userId) {
      this.presenceService.remove(client.userId, client.id);
    }
    client.rooms.forEach((room) => client.leave(room));
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinRoomDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const { workspaceId } = body;
    const isMember = await this.messageService.isWorkspaceMember(
      workspaceId,
      client.userId,
    );

    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    await client.join(workspaceId);

    const history = await this.messageService.getMessages(workspaceId);
    client.emit('messageHistory', history);
  }

  @SubscribeMessage('loadMoreMessages')
  async handleLoadMore(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: LoadMoreMessagesDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const { workspaceId, cursor } = body;
    const isMember = await this.messageService.isWorkspaceMember(
      workspaceId,
      client.userId,
    );

    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    const older = await this.messageService.getMessages(workspaceId, 50, cursor);
    client.emit('olderMessages', older);
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SendMessageDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const { workspaceId, content } = body;
    const trimmed = content.trim();

    if (!trimmed) return;

    const isMember = await this.messageService.isWorkspaceMember(
      workspaceId,
      client.userId,
    );

    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    const message = await this.messageService.saveMessage(
      workspaceId,
      client.userId,
      trimmed,
    );

    this.server.to(workspaceId).emit('newMessage', message);

    const senderName =
      [message.sender.firstname, message.sender.lastname]
        .filter(Boolean)
        .join(' ')
        .trim() || message.sender.email;

    // Fire-and-forget: notification delivery must never block or fail chat.
    void this.notificationService
      .notifyNewMessage({
        workspaceId,
        senderId: client.userId,
        senderName,
        content: trimmed,
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Failed to dispatch message notifications',
          error instanceof Error ? error.stack : undefined,
        );
      });
  }
}
