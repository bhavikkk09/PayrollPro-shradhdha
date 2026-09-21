import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';

/** Never leaks stack traces; every unexpected error gets an id the user can quote. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private log = new Logger('Errors');
  catch(e: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    // A late error after the response started must never throw again (that would crash the whole process).
    if (res.headersSent) { this.log.error(`Error after response was sent: ${e instanceof Error ? e.message : String(e)}`); return; }
    if (e instanceof HttpException) {
      const body = e.getResponse();
      return res.status(e.getStatus()).json(typeof body === 'string' ? { message: body } : body);
    }
    const errorId = randomUUID();
    this.log.error(`[${errorId}] ${e instanceof Error ? e.stack : String(e)}`);
    res.status(500).json({ message: 'Something went wrong', errorId });
  }
}
