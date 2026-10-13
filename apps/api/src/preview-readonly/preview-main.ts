import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { previewConfig } from './preview.config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PreviewReadOnlyModule } from './preview.module.js';
import { previewRoutePolicy } from './preview.route-policy.js';

async function bootstrap() {
  const config = previewConfig(process.env);
  const app = await NestFactory.create(PreviewReadOnlyModule.register(config), { bufferLogs: true });
  // Mounted before request parsing/controller dispatch. No public callbacks,
  // webhooks, workers, schedules, upload handlers, or provider modules exist here.
  app.use(previewRoutePolicy);
  app.setGlobalPrefix('api');
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.enableShutdownHooks();
  await app.init();
  await app.get(PrismaService).withPreviewReadOnly(config.preview.PREVIEW_TENANT_ID, async () => undefined);
  await app.listen(config.app.API_PORT, config.app.API_BIND_HOST);
}

bootstrap().catch(() => {
  // Connection exceptions may contain credential-bearing URLs; never echo them.
  console.error('Preview startup refused');
  process.exit(1);
});
