import { OnModuleDestroy, UsePipes, ValidationPipe } from '@nestjs/common';
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
import { WhiteboardService } from './whiteboard.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { JoinBoardDto } from './dto/join-board.dto';
import { SceneUpdateDto } from './dto/scene-update.dto';
import { PointerUpdateDto } from './dto/pointer-update.dto';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  firstname: string | null;
  lastname: string | null;
}

type PendingPayload = {
  elements: unknown[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

const PERSIST_DEBOUNCE_MS = 2000;

@WebSocketGateway({
  cors: { origin: process.env.ALLOWED_ORIGIN, credentials: true },
  namespace: '/whiteboard',
})
@UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
export class WhiteboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer()
  server: Server;

  private pendingTimers = new Map<string, NodeJS.Timeout>();
  private pendingPayloads = new Map<string, PendingPayload>();

  constructor(
    private readonly whiteboardService: WhiteboardService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  handleConnection(client: AuthenticatedSocket) {
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

      client.userId = payload.userId;
      client.userEmail = payload.email;
      client.firstname = null;
      client.lastname = null;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    client.rooms.forEach((room) => {
      if (room !== client.id && client.userId) {
        client.to(room).emit('collaboratorLeft', { userId: client.userId });
      }
      void client.leave(room);
    });
  }

  async onModuleDestroy() {
    for (const [workspaceId, timer] of this.pendingTimers.entries()) {
      clearTimeout(timer);
      const payload = this.pendingPayloads.get(workspaceId);
      if (payload) await this.whiteboardService.persist(workspaceId, payload);
    }
    this.pendingTimers.clear();
    this.pendingPayloads.clear();
  }

  @SubscribeMessage('joinBoard')
  async handleJoinBoard(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinBoardDto,
  ) {
    const { workspaceId } = body;
    const allowed = await this.whiteboardService.canAccess(
      workspaceId,
      client.userId,
    );

    if (!allowed) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    await client.join(workspaceId);

    if (client.firstname === null && client.lastname === null) {
      const profile = await this.whiteboardService.getUserName(client.userId);
      client.firstname = profile?.firstname ?? null;
      client.lastname = profile?.lastname ?? null;
    }

    const board =
      await this.whiteboardService.getOrCreateForSocket(workspaceId);
    client.emit('boardState', board);

    client.to(workspaceId).emit('collaboratorJoined', {
      userId: client.userId,
      email: client.userEmail,
      firstname: client.firstname,
      lastname: client.lastname,
    });
  }

  @SubscribeMessage('sceneUpdate')
  async handleSceneUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SceneUpdateDto,
  ) {
    const { workspaceId, elements, appState, files } = body;

    const allowed = await this.whiteboardService.canAccess(
      workspaceId,
      client.userId,
    );

    if (!allowed) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    client.to(workspaceId).emit('sceneUpdate', {
      elements,
      appState,
      files,
      from: client.userId,
    });

    this.schedulePersist(workspaceId, { elements, appState, files });
  }

  @SubscribeMessage('pointerUpdate')
  handlePointerUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: PointerUpdateDto,
  ) {
    const { workspaceId, pointer, button } = body;

    if (!client.rooms.has(workspaceId)) return;

    client.to(workspaceId).emit('pointerUpdate', {
      userId: client.userId,
      email: client.userEmail,
      firstname: client.firstname,
      lastname: client.lastname,
      pointer,
      button,
    });
  }

  private schedulePersist(workspaceId: string, payload: PendingPayload) {
    this.pendingPayloads.set(workspaceId, payload);

    const existing = this.pendingTimers.get(workspaceId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const latest = this.pendingPayloads.get(workspaceId);
      this.pendingTimers.delete(workspaceId);
      this.pendingPayloads.delete(workspaceId);
      if (!latest) return;
      void this.whiteboardService.persist(workspaceId, latest);
    }, PERSIST_DEBOUNCE_MS);

    this.pendingTimers.set(workspaceId, timer);
  }
}
