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

interface AuthenticatedSocket extends Socket {
  userId: string;
  userEmail: string;
}

@WebSocketGateway({
  cors: { origin: process.env.ALLOWED_ORIGIN, credentials: true },
  namespace: '/chat',
})
export class MessageGateway implements OnGatewayConnection, OnGatewayDisconnect {
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
    @MessageBody() workspaceId: string,
  ) {
    const isMember = await this.messageService.isWorkspaceMember(workspaceId, client.userId);

    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    await client.join(workspaceId);

    const history = await this.messageService.getMessages(workspaceId);
    client.emit('messageHistory', history);
  }

  @SubscribeMessage('sendMessage')
  async handleSendMessage(
    @ConnectedSocket() client: AuthenticatedSocket,
    @MessageBody() body: { workspaceId: string; content: string },
  ) {
    const { workspaceId, content } = body;

    if (!content?.trim()) return;

    const isMember = await this.messageService.isWorkspaceMember(workspaceId, client.userId);

    if (!isMember) {
      client.emit('error', { message: 'Access denied' });
      return;
    }

    const message = await this.messageService.saveMessage(workspaceId, client.userId, content.trim());

    this.server.to(workspaceId).emit('newMessage', message);
  }
}
