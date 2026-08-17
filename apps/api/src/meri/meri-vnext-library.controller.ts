import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { MeriVNextLibraryService } from './meri-vnext-library.service.js';

class SavedPromptDto {
  @IsString()
  @Length(1, 160)
  title!: string;

  @IsString()
  @Length(1, 24_000)
  body!: string;
}

class SavedPromptPatchDto {
  @IsOptional()
  @IsString()
  @Length(1, 160)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(1, 24_000)
  body?: string;
}

class WorkspaceDto {
  @IsString()
  @Length(1, 120)
  name!: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;
}

class WorkspacePatchDto {
  @IsOptional()
  @IsString()
  @Length(1, 120)
  name?: string;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  clientId?: string | null;
}

class ConversationWorkspaceDto {
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  workspaceId!: string | null;
}

class MeriVNextPreferenceDto {
  @IsString()
  windowChrome!: string;

  @IsBoolean()
  railCollapsed!: boolean;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  openSection!: string | null;
}

@Controller('clio/vnext')
@UseGuards(RolesGuard)
@Roles('capiro_admin', 'user_admin', 'standard_user')
export class MeriVNextLibraryController {
  constructor(private readonly library: MeriVNextLibraryService) {}

  @Get('saved-prompts')
  listSavedPrompts(@CurrentTenant() ctx: TenantContext) {
    return this.library.listSavedPrompts(ctx);
  }

  @Post('saved-prompts')
  createSavedPrompt(@CurrentTenant() ctx: TenantContext, @Body() body: SavedPromptDto) {
    return this.library.createSavedPrompt(ctx, body);
  }

  @Patch('saved-prompts/:id')
  updateSavedPrompt(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: SavedPromptPatchDto,
  ) {
    return this.library.updateSavedPrompt(ctx, id, body);
  }

  @Delete('saved-prompts/:id')
  deleteSavedPrompt(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.library.deleteSavedPrompt(ctx, id);
  }

  @Get('workspaces')
  listWorkspaces(@CurrentTenant() ctx: TenantContext) {
    return this.library.listWorkspaces(ctx);
  }

  @Post('workspaces')
  createWorkspace(@CurrentTenant() ctx: TenantContext, @Body() body: WorkspaceDto) {
    return this.library.createWorkspace(ctx, body);
  }

  @Patch('workspaces/:id')
  updateWorkspace(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: WorkspacePatchDto,
  ) {
    return this.library.updateWorkspace(ctx, id, body);
  }

  @Delete('workspaces/:id')
  deleteWorkspace(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.library.deleteWorkspace(ctx, id);
  }

  @Get('preferences')
  getPreferences(@CurrentTenant() ctx: TenantContext) {
    return this.library.getPreferences(ctx);
  }

  @Put('preferences')
  savePreferences(@CurrentTenant() ctx: TenantContext, @Body() body: MeriVNextPreferenceDto) {
    return this.library.savePreferences(ctx, body);
  }

  @Patch('conversations/:id/workspace')
  assignConversation(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() body: ConversationWorkspaceDto,
  ) {
    return this.library.assignConversation(ctx, id, body.workspaceId);
  }
}
