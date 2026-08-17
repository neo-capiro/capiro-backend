import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { InternalAuthGuard } from './internal-auth.guard.js';

@Global()
@Module({
  providers: [
    InternalAuthGuard,
    { provide: APP_GUARD, useExisting: InternalAuthGuard },
  ],
  exports: [InternalAuthGuard],
})
export class InternalAuthModule {}
