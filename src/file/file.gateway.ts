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
import { JoinFileRoomDto } from './dto/join-file-room.dto';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  tokenExpiresAt?: number;
}

@WebSocketGateway({
  cors: { origin: process.env.ALLOWED_ORIGIN, credentials: true },
  namespace: '/files',
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class FileGateway implements OnGatewayConnection, OnGatewayDisconnect {
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

      // Stamp auth state synchronously, before the async status lookup.
      // handleConnection is async and socket.io does not buffer inbound
      // events until it resolves, so a client that emits on connect can be
      // handled before these are set. Without them rejectExpiredSocket
      // would see no tokenExpiresAt and drop the socket as "expired".
      client.userId = payload.userId;
      client.userEmail = payload.email;
      // Recorded so handlers can drop the socket once the access token
      // expires — verifying the JWT only at connect time isn't enough
      // when the socket lives for hours.
      client.tokenExpiresAt = payload.exp;

      const user = await this.prisma.user.findUnique({
        where: { id: payload.userId },
        select: { status: true },
      });
      if (!user || user.status !== UserStatus.ACTIVE) {
        client.disconnect();
        return;
      }
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    client.rooms.forEach((room) => void client.leave(room));
  }

  @SubscribeMessage('joinFilesRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinFileRoomDto,
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

  // Called by FileService after a successful mutation. Broadcasts to every
  // connected member of the workspace so the active files list (and the
  // "new files" dot) update without a refresh. Restores reuse `fileCreated`
  // since the file simply re-enters the active list.
  emitFileCreated(workspaceId: string, file: unknown) {
    this.server.to(this.roomFor(workspaceId)).emit('fileCreated', file);
  }

  emitFileDeleted(workspaceId: string, fileId: string) {
    this.server
      .to(this.roomFor(workspaceId))
      .emit('fileDeleted', { id: fileId });
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
