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
import { TypingDto } from './dto/typing.dto';
import { MarkReadDto } from './dto/mark-read.dto';
import { PresenceService } from '../presence/presence.service';
import { NotificationService } from '../notification/notification.service';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  // Cached at connect so typing events (which fire on every keystroke) never
  // hit the database to resolve a display name.
  userName: string;
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

      // Stamp auth state synchronously, before the async status lookup.
      // handleConnection is async and socket.io does not buffer inbound
      // events until it resolves, so a client that emits on connect can be
      // handled before these are set. Without them rejectExpiredSocket
      // would see no tokenExpiresAt and drop the socket as "expired".
      client.userId = payload.userId;
      client.userEmail = payload.email;
      // Record exp so handlers can drop the socket once the access token
      // expires — verifying the JWT only at connect time isn't enough
      // when the socket lives for hours.
      client.tokenExpiresAt = payload.exp;

      const user = await this.prismaService.user.findUnique({
        where: { id: payload.userId },
        select: { status: true, firstname: true, lastname: true },
      });
      if (!user || user.status !== UserStatus.ACTIVE) {
        client.disconnect();
        return;
      }

      client.userName =
        [user.firstname, user.lastname].filter(Boolean).join(' ').trim() ||
        payload.email;
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

    // Send how far the other participants have read, so the sender can show
    // "seen" on past messages immediately rather than waiting for a new event.
    const readState = await this.messageService.getReadState(
      workspaceId,
      client.userId,
    );
    client.emit('readState', readState);
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

  @SubscribeMessage('typing')
  handleTyping(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: TypingDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    // Only relay typing within rooms the socket has actually joined (which
    // already passed the membership check), so nobody can spam a workspace
    // they don't belong to. Broadcast to everyone in the room except sender.
    if (!client.rooms.has(body.workspaceId)) return;
    client.to(body.workspaceId).emit('userTyping', {
      userId: client.userId,
      name: client.userName,
      isTyping: body.isTyping,
    });
  }

  @SubscribeMessage('markRead')
  async handleMarkRead(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: MarkReadDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    if (!client.rooms.has(body.workspaceId)) return;

    const lastReadAt = await this.messageService.markRead(
      body.workspaceId,
      client.userId,
    );
    // Tell the other participants this user has caught up.
    client.to(body.workspaceId).emit('readReceipt', {
      userId: client.userId,
      lastReadAt,
    });
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
