import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import helmet from 'helmet';
import { AppModule } from './app.module';

/** Never leaks stack traces; every unexpected error gets an id the user can quote. */
@Catch()
class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('Errors');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) {
      const body = e.getResponse();
      return res.status(e.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    }
    const errorId = randomUUID();
    this.log.error(`[${errorId}] ${e instanceof Error ? e.stack : String(e)}`);
    res.status(500).json({ message: 'Something went wrong', errorId });
  }
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.use(helmet());
  app.useBodyParser('json', { limit: '5mb' }); // attendance imports send up to 20k rows
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('LabourConsultPro API').setVersion('0.1').addBearerAuth().build(),
  );
  SwaggerModule.setup('api/docs', app, doc);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
