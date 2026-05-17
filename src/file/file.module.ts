import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { FileController } from './file.controller';
import { FileService } from './file.service';
import { StorageService } from './storage/storage.service';
import { R2StorageService } from './storage/r2-storage.service';
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
  controllers: [FileController],
  providers: [
    FileService,
    { provide: StorageService, useClass: R2StorageService },
  ],
  exports: [FileService, StorageService],
})
export class FileModule {}
