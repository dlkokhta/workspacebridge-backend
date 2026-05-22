import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrivateTaskController } from './private-task.controller';
import { PrivateTaskService } from './private-task.service';
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
  controllers: [PrivateTaskController],
  providers: [PrivateTaskService],
  exports: [PrivateTaskService],
})
export class PrivateTaskModule {}
