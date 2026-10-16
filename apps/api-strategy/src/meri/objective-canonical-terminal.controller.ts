import { Body, Controller, Get, Header, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ObjectiveCanonicalTerminalService } from './objective-canonical-terminal.service.js';

@Controller('internal/objective-canonical/generation-terminals')
export class ObjectiveCanonicalTerminalController {
  constructor(private readonly terminal: ObjectiveCanonicalTerminalService) {}
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'private, no-store')
  account(@Req() req: Request, @Body() body: unknown) { return this.terminal.account(req, body); }
  @Get(':generationJobId')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  read(@Req() req: Request, @Param('generationJobId') id: string) { return this.terminal.lookup(req, id); }
}
