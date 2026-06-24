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
  // The workspace whose Messages tab this socket currently has open, if any.
  // Tracked so disconnects can clear the active-viewer registry below.
  viewingWorkspaceId?: string;
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

  // workspaceId -> userId -> socket ids that currently have that workspace's
  // Messages tab open. A user viewing the thread on any socket is an "active
  // viewer" and is skipped when dispatching new-message notifications: they
  // are already watching the conversation, so a bell badge would be noise.
  private readonly messageViewers = new Map<string, Map<string, Set<string>>>();

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
      if (client.viewingWorkspaceId) {
        this.removeViewer(client.viewingWorkspaceId, client);
      }
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
    // The Messages tab is now open for this socket, so suppress new-message
    // notifications to this user for this workspace while it stays open.
    this.addViewer(workspaceId, client);

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

  @SubscribeMessage('leaveRoom')
  handleLeaveRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinRoomDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    // The Messages tab closed (tab switch / navigation). Clear the active-viewer
    // flag so new-message notifications to this user resume. The socket keeps
    // its room membership so the unread badge still updates from other tabs.
    this.removeViewer(body.workspaceId, client);
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

  @SubscribeMessage('getUnreadCount')
  async handleGetUnreadCount(
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

    // Join the room so this socket keeps receiving `newMessage` even while the
    // user sits on another tab — that's what lets the unread badge tick up live
    // without opening Messages. Unlike `joinRoom`, no history is sent.
    await client.join(workspaceId);

    const count = await this.messageService.unreadCount(
      workspaceId,
      client.userId,
    );
    client.emit('unreadCount', { workspaceId, count });
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

    // Anyone with this workspace's Messages tab open is reading live; skip
    // their bell notification (the sender is already excluded downstream).
    const activeViewerIds = this.getViewerIds(workspaceId);

    // Fire-and-forget: notification delivery must never block or fail chat.
    void this.notificationService
      .notifyNewMessage({
        workspaceId,
        senderId: client.userId,
        senderName,
        content: trimmed,
        activeViewerIds,
      })
      .catch((error: unknown) => {
        this.logger.error(
          'Failed to dispatch message notifications',
          error instanceof Error ? error.stack : undefined,
        );
      });
  }

  // Records that a socket has this workspace's Messages tab open. Replaces any
  // previously viewed workspace for the same socket (e.g. switching workspaces
  // without a clean unmount) so a socket only ever counts once.
  private addViewer(workspaceId: string, client: AuthenticatedSocket): void {
    if (
      client.viewingWorkspaceId &&
      client.viewingWorkspaceId !== workspaceId
    ) {
      this.removeViewer(client.viewingWorkspaceId, client);
    }

    let byUser = this.messageViewers.get(workspaceId);
    if (!byUser) {
      byUser = new Map<string, Set<string>>();
      this.messageViewers.set(workspaceId, byUser);
    }
    const sockets = byUser.get(client.userId);
    if (sockets) {
      sockets.add(client.id);
    } else {
      byUser.set(client.userId, new Set([client.id]));
    }
    client.viewingWorkspaceId = workspaceId;
  }

  // Clears a socket's active-viewer entry, pruning now-empty inner maps. Leaves
  // the socket.io room membership untouched: the socket stays subscribed to
  // `newMessage` so the unread badge keeps ticking from other tabs.
  private removeViewer(workspaceId: string, client: AuthenticatedSocket): void {
    const byUser = this.messageViewers.get(workspaceId);
    if (byUser) {
      const sockets = byUser.get(client.userId);
      if (sockets) {
        sockets.delete(client.id);
        if (sockets.size === 0) byUser.delete(client.userId);
      }
      if (byUser.size === 0) this.messageViewers.delete(workspaceId);
    }
    if (client.viewingWorkspaceId === workspaceId) {
      client.viewingWorkspaceId = undefined;
    }
  }

  // Ids of users currently viewing this workspace's Messages tab.
  private getViewerIds(workspaceId: string): string[] {
    return [...(this.messageViewers.get(workspaceId)?.keys() ?? [])];
  }
}
