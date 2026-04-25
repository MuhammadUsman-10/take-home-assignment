import {
  CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const requestId = (request.headers['x-request-id'] as string) ?? uuidv4();
    request.headers['x-request-id'] = requestId;

    const { method, url } = request;
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const response = context.switchToHttp().getResponse();
        const ms = Date.now() - start;
        this.logger.log(
          `[${requestId}] ${method} ${url} → ${response.statusCode} (${ms}ms)`,
        );
      }),
    );
  }
}
