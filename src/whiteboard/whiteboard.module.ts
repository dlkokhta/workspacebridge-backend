import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WhiteboardController } from './whiteboard.controller';
import { WhiteboardCommentController } from './whiteboard-comment.controller';
import { WhiteboardService } from './whiteboard.service';
import { WhiteboardCommentService } from './whiteboard-comment.service';
import { WhiteboardGateway } from './whiteboard.gateway';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [WhiteboardController, WhiteboardCommentController],
  providers: [WhiteboardService, WhiteboardCommentService, WhiteboardGateway],
  exports: [WhiteboardService, WhiteboardCommentService],
})
export class WhiteboardModule {}
