import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
// import IORedis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService);
  app.use(cookieParser());
  app.use(helmet());
  // const redis = new IORedis(config.getOrThrow<string>('REDIS_URL'));

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
    }),
  );

  //cors config
  app.enableCors({
    origin: config.getOrThrow<string>('ALLOWED_ORIGIN'),
    credentials: true,
    exposedHeaders: ['set-cookie'],
    allowedHeaders: [
      'Accept',
      'Authorization',
      'Content-Type',
      'X-Requested-With',
      'apollo-require-preflight',
    ],
    methods: ['GET', 'PUT', 'POST', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  // swagger config
  const swaggerConfig = new DocumentBuilder()
    .setTitle('WorkSpaceBridge API')
    .setDescription('API documentaion for WorkSpaceBridge application')
    .setVersion('1.0.0')
    .setContact(
      'Dimitri',
      'https://dimitrikokhtashvili.com',
      'dl.kokhtashvili@gmail.com',
    )
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth', // This name here is important for matching the same name in the controller
    )
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  delete document.components?.schemas;
  SwaggerModule.setup('/docs', app, document);

  await app.listen(config.getOrThrow<number>('APPLICATION_PORT'));
}
bootstrap();
