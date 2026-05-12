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
    for (const [boardId, timer] of this.pendingTimers.entries()) {
      clearTimeout(timer);
      const payload = this.pendingPayloads.get(boardId);
      if (payload) await this.whiteboardService.persist(boardId, payload);
    }
    this.pendingTimers.clear();
    this.pendingPayloads.clear();
  }

  @SubscribeMessage('joinBoard')
  async handleJoinBoard(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinBoardDto,
  ) {
    const { boardId } = body;
    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      client.userId,
    );

    if (!allowed) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    await client.join(boardId);

    if (client.firstname === null && client.lastname === null) {
      const profile = await this.whiteboardService.getUserName(client.userId);
      client.firstname = profile?.firstname ?? null;
      client.lastname = profile?.lastname ?? null;
    }

    const board = await this.whiteboardService.getByIdForSocket(boardId);
    client.emit('boardState', board);

    client.to(boardId).emit('collaboratorJoined', {
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
    const { boardId, elements, appState, files } = body;

    const allowed = await this.whiteboardService.canAccessBoard(
      boardId,
      client.userId,
    );

    if (!allowed) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    client.to(boardId).emit('sceneUpdate', {
      elements,
      appState,
      files,
      from: client.userId,
    });

    this.schedulePersist(boardId, { elements, appState, files });
  }

  @SubscribeMessage('pointerUpdate')
  handlePointerUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: PointerUpdateDto,
  ) {
    const { boardId, pointer, button } = body;

    if (!client.rooms.has(boardId)) return;

    client.to(boardId).emit('pointerUpdate', {
      userId: client.userId,
      email: client.userEmail,
      firstname: client.firstname,
      lastname: client.lastname,
      pointer,
      button,
    });
  }

  private schedulePersist(boardId: string, payload: PendingPayload) {
    this.pendingPayloads.set(boardId, payload);

    const existing = this.pendingTimers.get(boardId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const latest = this.pendingPayloads.get(boardId);
      this.pendingTimers.delete(boardId);
      this.pendingPayloads.delete(boardId);
      if (!latest) return;
      void this.whiteboardService.persist(boardId, latest);
    }, PERSIST_DEBOUNCE_MS);

    this.pendingTimers.set(boardId, timer);
  }
}
