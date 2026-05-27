import { UsePipes, ValidationPipe } from '@nestjs/common';
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
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserStatus } from '@prisma/client';
import { rejectExpiredSocket } from '../libs/common/utils/socket-auth';
import { JoinSharedTaskRoomDto } from './dto/join-shared-task-room.dto';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  tokenExpiresAt?: number;
}

@WebSocketGateway({
  cors: { origin: process.env.ALLOWED_ORIGIN, credentials: true },
  namespace: '/shared-tasks',
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class SharedTaskGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
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

      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { status: true },
      });
      if (!user || user.status !== UserStatus.ACTIVE) {
        client.disconnect();
        return;
      }

      client.userId = payload.userId;
      client.userEmail = payload.email;
      // Recorded so handlers can drop the socket once the access token
      // expires — verifying the JWT only at connect time isn't enough
      // when the socket lives for hours.
      client.tokenExpiresAt = payload.exp;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    client.rooms.forEach((room) => client.leave(room));
  }

  @SubscribeMessage('joinSharedTasksRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinSharedTaskRoomDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const { workspaceId } = body;

    const isMember = await this.isWorkspaceMember(workspaceId, client.userId);
    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    await client.join(this.roomFor(workspaceId));
  }

  // Called by SharedTaskService after a successful mutation. Broadcasts to
  // every connected member of the workspace so the other side updates
  // without a refresh.
  emitTaskCreated(workspaceId: string, task: unknown) {
    this.server.to(this.roomFor(workspaceId)).emit('sharedTaskCreated', task);
  }

  emitTaskUpdated(workspaceId: string, task: unknown) {
    this.server.to(this.roomFor(workspaceId)).emit('sharedTaskUpdated', task);
  }

  emitTaskDeleted(workspaceId: string, taskId: string) {
    this.server
      .to(this.roomFor(workspaceId))
      .emit('sharedTaskDeleted', { id: taskId });
  }

  private roomFor(workspaceId: string): string {
    return `workspace:${workspaceId}`;
  }

  private async isWorkspaceMember(
    workspaceId: string,
    userId: string,
  ): Promise<boolean> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        ownerId: true,
        members: { where: { userId }, select: { id: true } },
      },
    });
    if (!workspace) return false;
    return workspace.ownerId === userId || workspace.members.length > 0;
  }
}
