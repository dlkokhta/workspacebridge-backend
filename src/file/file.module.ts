import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FileController } from './file.controller';
import { FileCommentController } from './file-comment.controller';
import { FileService } from './file.service';
import { FileCommentService } from './file-comment.service';
import { FileCleanupService } from './file-cleanup.service';
import { FileGateway } from './file.gateway';
import { StorageService } from './storage/storage.service';
import { R2StorageService } from './storage/r2-storage.service';
import { PrismaModule } from '../prisma/prisma.module';
import { NotificationModule } from '../notification/notification.module';

@Module({
  imports: [
    PrismaModule,
    NotificationModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
      }),
    }),
  ],
  controllers: [FileController, FileCommentController],
  providers: [
    FileService,
    FileCommentService,
    FileCleanupService,
    FileGateway,
    { provide: StorageService, useClass: R2StorageService },
  ],
  exports: [FileService, StorageService],
})
export class FileModule {}
