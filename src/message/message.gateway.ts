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
import { MessageService } from './message.service';
import { JwtPayload } from '../auth/types/jwt-payload.type';
import { SendMessageDto } from './dto/send-message.dto';
import { JoinRoomDto } from './dto/join-room.dto';
import { LoadMoreMessagesDto } from './dto/load-more.dto';

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
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

  constructor(
    private readonly messageService: MessageService,
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

      client.userId = payload.userId;
      client.userEmail = payload.email;
    } catch {
      client.disconnect();
    }
  }

  handleDisconnect(client: AuthenticatedSocket) {
    client.rooms.forEach((room) => client.leave(room));
  }

  @SubscribeMessage('joinRoom')
  async handleJoinRoom(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: JoinRoomDto,
  ) {
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
  }
}
