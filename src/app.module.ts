import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthController } from './health/health.controller';
import { HealthService } from './health/health.service';
import { validateEnv } from './config/env.validation';
import { GlobalExceptionFilter } from './libs/common/filters/global-exception.filter';
import { genRequestId } from './libs/common/utils/request-id';
import { AuthModule } from './auth/auth.module';
import { IS_DEV_ENV } from './libs/common/utils/is-dev.utils';
import { UserModule } from './user/user.module';
import { PrismaService } from './prisma/prisma.service';
import { ConfigModule } from '@nestjs/config';
import { MailModule } from './mail/mail.module';
import { AdminModule } from './admin/admin.module';
import { WorkspaceModule } from './workspace/workspace.module';
import { InviteModule } from './invite/invite.module';
import { MessageModule } from './message/message.module';
import { WhiteboardModule } from './whiteboard/whiteboard.module';
import { FileModule } from './file/file.module';
import { SharedLinkModule } from './shared-link/shared-link.module';
import { SharedTaskModule } from './shared-task/shared-task.module';
import { PrivateTaskModule } from './private-task/private-task.module';
import { NotificationModule } from './notification/notification.module';
import { SearchModule } from './search/search.module';
import { FeedbackModule } from './feedback/feedback.module';
import { ThrottlerModule, ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { Injectable } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

@Injectable()
class CustomThrottlerGuard extends ThrottlerGuard {
  protected throwThrottlingException(): Promise<void> {
    throw new ThrottlerException('Too many attempts. Please try again later.');
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      ignoreEnvFile: !IS_DEV_ENV,
      isGlobal: true,
      validate: validateEnv,
    }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60000,
        limit: 60,
      },
    ]),
    ScheduleModule.forRoot(),
    LoggerModule.forRoot({
      pinoHttp: {
        // Per-request correlation id: reuse a valid inbound X-Request-Id or
        // mint a UUID, echo it on the response, and tag every log line with it.
        genReqId: genRequestId,
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty', options: { colorize: true, singleLine: true } }
            : undefined,
        level: process.env.NODE_ENV !== 'production' ? 'debug' : 'info',
        autoLogging: true,
        redact: ['req.headers.authorization'],
      },
    }),
    AuthModule,
    UserModule,
    MailModule,
    AdminModule,
    WorkspaceModule,
    InviteModule,
    MessageModule,
    WhiteboardModule,
    FileModule,
    SharedLinkModule,
    SharedTaskModule,
    PrivateTaskModule,
    NotificationModule,
    SearchModule,
    FeedbackModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    HealthService,
    PrismaService,
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
