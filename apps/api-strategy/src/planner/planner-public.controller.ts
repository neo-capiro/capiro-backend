import { Body, Controller, Get, Param, Post, Header } from '@nestjs/common';
import { PlannerService } from './planner.service.js';

/** Only explicit, revocable form capabilities are anonymous. Every operation
 * uses withTenant; these routes never expose a task or use a system bypass. */
@Controller('planner/public/forms')
export class PlannerPublicController {
  constructor(private readonly planner: PlannerService) {}
  @Get(':token')
  @Header('Cache-Control', 'private, no-store')
  @Header('Referrer-Policy', 'no-referrer')
  form(@Param('token') token: string) {
    return this.planner.publicForm(token);
  }
  @Post(':token')
  @Header('Cache-Control', 'private, no-store')
  submit(@Param('token') token: string, @Body() dto: unknown) {
    return this.planner.submitPublicForm(token, dto);
  }
}
