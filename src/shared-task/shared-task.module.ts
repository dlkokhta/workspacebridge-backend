import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { SharedTaskController } from './shared-task.controller';
import { SharedTaskService } from './shared-task.service';
import { SharedTaskGateway } from './shared-task.gateway';
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
  controllers: [SharedTaskController],
  providers: [SharedTaskService, SharedTaskGateway],
  exports: [SharedTaskService],
})
export class SharedTaskModule {}
