import { Body, Controller, Header, HttpCode, Inject, Post, Req, Res, ServiceUnavailableException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RetainedFloridaReadService } from './retained-florida-read.service.js';
import { retainedFloridaRequest } from './retained-florida-request.js';

/** Unmounted, signed-only internal reads. Each service method owns its codec. */
@Controller('internal/legiwatch')
export class RetainedFloridaReadController {
  constructor(@Inject(RetainedFloridaReadService) private readonly source: RetainedFloridaReadService | null) {}

  @Post('retained-florida-authority')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  authority(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    return this.run(req, res, body, 'authority');
  }

  @Post('retained-florida-budget')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'application/json; charset=utf-8')
  budget(@Req() req: Request, @Res({ passthrough: true }) res: Response, @Body() body: unknown) {
    return this.run(req, res, body, 'budget');
  }

  private async run(req: Request, res: Response, body: unknown, operation: 'authority' | 'budget') {
    // Set before parsing/lifetime/source checks so every handled denial is no-store.
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const control = retainedFloridaRequest(req, res);
    try {
      return await control.run(async () => {
        if (!this.source) throw new ServiceUnavailableException('Retained Florida authority unavailable');
        const authorization = req.headers.authorization;
        return operation === 'authority'
          ? this.source.authority(authorization, body, control)
          : this.source.budget(authorization, body, control);
      });
    } finally { control.close(); }
  }
}
