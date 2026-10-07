import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Header,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
} from '@nestjs/common';
import { PlannerService } from './planner.service.js';
import { PlannerFormUploadInterceptor } from './planner-form-upload.js';
import { PlannerPublicFormGuard } from './planner-public-form.guard.js';
import type { PlannerFormUpload } from './planner-files.js';

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
  @UseGuards(PlannerPublicFormGuard)
  @UseInterceptors(PlannerFormUploadInterceptor)
  @Header('Cache-Control', 'private, no-store')
  submit(
    @Param('token') token: string,
    @Body() dto: unknown,
    @UploadedFiles() files: PlannerFormUpload[] = [],
  ) {
    return this.planner.submitPublicForm(token, dto, files);
  }
}
