import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { RequestContextMiddleware } from './request-context.middleware.js';

@Global()
@Module({
  providers: [RequestContextMiddleware],
  exports: [RequestContextMiddleware],
})
export class RequestContextModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
