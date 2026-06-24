import {
  forwardRef,
  Inject,
  OnModuleDestroy,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
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
import { PrismaService } from '../prisma/prisma.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { UserStatus } from '@prisma/client';
import { rejectExpiredSocket } from '../libs/common/utils/socket-auth';
import { JoinBoardDto } from './dto/join-board.dto';
import { SceneUpdateDto } from './dto/scene-update.dto';
import { PointerUpdateDto } from './dto/pointer-update.dto';
import { JoinWorkspaceBoardsDto } from './dto/join-workspace-boards.dto';

// Workspace-scoped room for board-list lifecycle (created / deleted / renamed)
// and presenter follow events — kept distinct from per-board rooms (raw ids).
const workspaceBoardsRoom = (workspaceId: string) => `ws-boards:${workspaceId}`;

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
  firstname: string | null;
  lastname: string | null;
  tokenExpiresAt?: number;
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
  // workspaceId -> the board the presenter (owner) is currently on, so a client
  // that opens the tab after the owner immediately follows to the right board.
  private readonly presentedBoards = new Map<string, string>();

  constructor(
    // forwardRef: the service also broadcasts through this gateway (direct cycle).
    @Inject(forwardRef(() => WhiteboardService))
    private readonly whiteboardService: WhiteboardService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prismaService: PrismaService,
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
      // events until it resolves, so a client that emits on connect (e.g.
      // joinBoard) can be handled before these are set. Without them
      // rejectExpiredSocket would see no tokenExpiresAt and drop the socket
      // as "expired", leaving the board stuck on "Loading whiteboard…".
      client.userId = payload.userId;
      client.userEmail = payload.email;
      client.firstname = null;
      client.lastname = null;
      // Recorded so handlers can drop the socket once the access token
      // expires — verifying the JWT only at connect time isn't enough
      // when boards stay open for hours.
      client.tokenExpiresAt = payload.exp;

      const user = await this.prismaService.user.findUnique({
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
    if (rejectExpiredSocket(client)) return;
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

  // Subscribes a socket to its workspace's board-list lifecycle + presenter
  // events. Kept separate from joinBoard so the tab bar stays in sync even
  // before (or without) any specific board being open.
  @SubscribeMessage('joinWorkspaceBoards')
  async handleJoinWorkspaceBoards(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinWorkspaceBoardsDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const allowed = await this.whiteboardService.canAccessWorkspace(
      body.workspaceId,
      client.userId,
    );
    if (!allowed) {
      client.emit('error', { message: 'Access denied' });
      return;
    }
    await client.join(workspaceBoardsRoom(body.workspaceId));

    // Catch a late joiner up to the presenter's current board (the frontend
    // ignores this for the owner, who is the one driving).
    const presented = this.presentedBoards.get(body.workspaceId);
    if (presented) client.emit('boardPresented', { boardId: presented });
  }

  @SubscribeMessage('leaveWorkspaceBoards')
  handleLeaveWorkspaceBoards(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinWorkspaceBoardsDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    void client.leave(workspaceBoardsRoom(body.workspaceId));
  }

  // The presenter (workspace owner) switched their active board; tell the
  // clients in the workspace room to follow. Only the owner may present, and
  // the broadcast room is derived server-side from the board, never trusted
  // from the payload.
  @SubscribeMessage('presentBoard')
  async handlePresentBoard(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinBoardDto,
  ) {
    if (rejectExpiredSocket(client)) return;
    const workspaceId = await this.whiteboardService.ownedBoardWorkspaceId(
      body.boardId,
      client.userId,
    );
    if (!workspaceId) return;
    this.presentedBoards.set(workspaceId, body.boardId);
    client
      .to(workspaceBoardsRoom(workspaceId))
      .emit('boardPresented', { boardId: body.boardId });
  }

  @SubscribeMessage('sceneUpdate')
  async handleSceneUpdate(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: SceneUpdateDto,
  ) {
    if (rejectExpiredSocket(client)) return;
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
    if (rejectExpiredSocket(client)) return;
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

  broadcastCommentCreated(boardId: string, comment: unknown) {
    this.server.to(boardId).emit('commentCreated', comment);
  }

  broadcastCommentDeleted(boardId: string, commentId: string) {
    this.server.to(boardId).emit('commentDeleted', { id: commentId, boardId });
  }

  broadcastBoardRestored(
    boardId: string,
    payload: {
      elements: unknown;
      appState: unknown;
      files: unknown;
    },
  ) {
    this.server.to(boardId).emit('boardRestored', { boardId, ...payload });
  }

  broadcastBoardCreated(
    workspaceId: string,
    board: { id: string; name: string; updatedAt: Date },
  ) {
    this.server
      .to(workspaceBoardsRoom(workspaceId))
      .emit('boardCreated', board);
  }

  broadcastBoardRenamed(
    workspaceId: string,
    board: { id: string; name: string; updatedAt: Date },
  ) {
    this.server
      .to(workspaceBoardsRoom(workspaceId))
      .emit('boardRenamed', board);
  }

  broadcastBoardDeleted(workspaceId: string, boardId: string) {
    // Drop a stale presenter pointer so late joiners aren't sent to a dead board.
    if (this.presentedBoards.get(workspaceId) === boardId) {
      this.presentedBoards.delete(workspaceId);
    }
    this.server
      .to(workspaceBoardsRoom(workspaceId))
      .emit('boardDeleted', { id: boardId });
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
