import 'reflect-metadata';
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { randomUUID } from 'crypto';
import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { static as serveStatic } from 'express';
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
  const prod = process.env.NODE_ENV === 'production';
  // Behind a proxy (Render, nginx) req.ip would be the proxy for everyone, so rate limits and audit IPs would be wrong.
  if (prod || process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet());
  app.useBodyParser('json', { limit: '5mb' }); // attendance imports send up to 20k rows
  app.enableCors({ origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','), credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());

  // API docs are off in production unless explicitly enabled.
  if (!prod || process.env.ENABLE_DOCS === 'true') {
    const doc = SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('LabourConsultPro API').setVersion('0.1').addBearerAuth().build());
    SwaggerModule.setup('api/docs', app, doc);
  }

  // One service can also serve the built web app (single-container deployments).
  const webDir = process.env.WEB_DIST ?? resolve(__dirname, '../../web/dist');
  if (existsSync(join(webDir, 'index.html'))) {
    const http = app.getHttpAdapter().getInstance();
    http.use(serveStatic(webDir, { index: false, maxAge: '1h' }));
    // Any non-API path returns the SPA so client-side routes survive a refresh.
    http.get(/^\/(?!api\/).*/, (_req: unknown, res: { sendFile: (p: string) => void }) => res.sendFile(join(webDir, 'index.html')));
  }

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
