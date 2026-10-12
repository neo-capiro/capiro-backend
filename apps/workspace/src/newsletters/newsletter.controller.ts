import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileFieldsInterceptor, FileInterceptor } from '@nestjs/platform-express';
import {
  IsBoolean,
  IsEmail,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  Max,
  IsIn,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
  Matches,
} from 'class-validator';
import type { Response } from 'express';
import { Type } from 'class-transformer';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { NewsletterService } from './newsletter.service.js';
class CreateDto {
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(100) templateId?: string;
}
class SaveDto {
  @IsInt() @Min(1) revision!: number;
  @IsString() @MaxLength(200) name!: string;
  @IsObject() design!: object;
  @IsObject() config!: object;
}
class StageDto {
  @IsInt() @Min(1) revision!: number;
}
class SurveyDraftDto {
  @IsString() @MaxLength(200) name!: string;
  @IsObject() definition!: object;
  @IsOptional() @IsUUID() id?: string;
  @IsOptional() @IsInt() @Min(1) @Max(1_000_000) revision?: number;
}
class LibraryDto {
  @IsString() @MaxLength(200) name!: string;
  @IsOptional() @IsString() @MaxLength(100) folder?: string;
  @IsOptional() @IsString() @MaxLength(100) sectionId?: string;
}
class UpdateLibraryDto {
  @IsString() @MaxLength(200) name!: string;
  @IsString() @MaxLength(100) folder!: string;
}
class CommentDto {
  @IsString() @MaxLength(10000) message!: string;
  @IsOptional() @IsString() @MaxLength(100) blockId?: string;
  @IsOptional() @IsUUID() parentId?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  notifyUserIds?: string[];
}
class ThreadNotificationsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  userIds!: string[];
}
class ResolveDto {
  @IsBoolean() resolved!: boolean;
}
class ReviewerDto {
  @IsString() @MaxLength(200) userId!: string;
  @IsIn(['viewer', 'commenter', 'editor']) role!: 'viewer' | 'commenter' | 'editor';
}
class EmailInvitationDto {
  @IsEmail() @MaxLength(320) email!: string;
  @IsIn(['viewer', 'commenter', 'editor']) role!: 'viewer' | 'commenter' | 'editor';
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
  @IsUUID() requestKey!: string;
  @IsOptional() @IsIn(['member', 'admin']) accountRole?: 'member' | 'admin';
}
class NotificationDto {
  @IsIn(['all', 'mentions', 'none']) mode!: 'all' | 'mentions' | 'none';
}
class WriteDto {
  @IsString() @MaxLength(4000) prompt!: string;
  @IsString() @MaxLength(30000) text!: string;
  @IsString() @MaxLength(100) kind!: string;
}
class PreviewDto {
  @IsOptional() @IsBoolean() liveMergeTags?: boolean;
}
class ImageEditDto {
  @IsString() @MaxLength(4000) prompt!: string;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([1, 4]) count?: number;
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) sourceToken?: string;
}
class ImageSourceDto {
  @IsOptional() @IsString() @Matches(/^[a-f0-9]{64}$/) sourceToken?: string;
}
class ImageRevisionDto extends ImageSourceDto {
  @IsOptional() @IsUUID() documentId?: string;
}
class ImageRevisionQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([10, 25, 50, 100]) pageSize?: number;
}
class AssetQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100_000) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @IsIn([10, 25, 50, 100]) pageSize?: number;
  @IsOptional() @IsString() @MaxLength(200) search?: string;
  @IsOptional() @IsIn(['newest', 'oldest', 'name-asc', 'name-desc']) sort?: string;
  @IsOptional() @IsString() @MaxLength(36) folder?: string;
}
class ImportAssetDto {
  @IsString() @MaxLength(2048) url!: string;
  @IsOptional() @IsUUID() folderId?: string;
}
class LinkPreviewDto {
  @IsString() @MaxLength(2048) url!: string;
}
class RenameAssetDto {
  @IsString() @MaxLength(200) name!: string;
}
class DeleteAssetsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) ids!: string[];
}
class AssetFolderDto {
  @IsString() @MaxLength(100) name!: string;
}
class CreateAssetFolderDto extends AssetFolderDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  assetIds?: string[];
}
class MoveAssetsDto extends DeleteAssetsDto {
  @ValidateIf((value: MoveAssetsDto) => value.folderId !== null) @IsUUID() folderId!: string | null;
}
class UploadAssetDto {
  @IsOptional() @IsUUID() folderId?: string;
}

@Controller('newsletters')
@UseGuards(TenantGuard)
export class NewsletterController {
  constructor(private readonly service: NewsletterService) {}
  @Get('brand-kit') brandKit(@CurrentTenant() c: WorkspaceTenantContext) {
    return this.service.brandKit(c);
  }
  @Patch('brand-kit') saveBrandKit(@CurrentTenant() c: WorkspaceTenantContext, @Body() b: object) {
    return this.service.saveBrandKit(c, b);
  }
  @Post('brand-kit/fonts')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024, files: 1 } }))
  uploadFont(
    @CurrentTenant() c: WorkspaceTenantContext,
    @UploadedFile() file: { buffer: Buffer; originalname: string },
  ) {
    return this.service.uploadFont(c, file);
  }
  @Get('capabilities') capabilities(@CurrentTenant() c: WorkspaceTenantContext) {
    return this.service.capabilities(c);
  }
  @Get('documents') list(@CurrentTenant() c: WorkspaceTenantContext) {
    return this.service.list(c);
  }
  @Post('documents') create(@CurrentTenant() c: WorkspaceTenantContext, @Body() b: CreateDto) {
    return this.service.create(c, b);
  }
  @Get('documents/:id/surveys') surveys(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.surveys(c, id);
  }
  @Post('documents/:id/surveys') saveSurvey(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: SurveyDraftDto,
  ) {
    return this.service.saveSurvey(c, id, b);
  }
  @Get('documents/:id') get(@CurrentTenant() c: WorkspaceTenantContext, @Param('id') id: string) {
    return this.service.get(c, id);
  }
  @Patch('documents/:id') save(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: SaveDto,
  ) {
    return this.service.save(c, id, b);
  }
  @Post('documents/:id/preview') preview(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: PreviewDto,
  ) {
    return this.service.preview(c, id, b);
  }
  @Post('documents/:id/stage') stage(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: StageDto,
  ) {
    return this.service.stage(c, id, b.revision);
  }
  @Post('documents/:id/write') write(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: WriteDto,
  ) {
    return this.service.write(c, id, b);
  }
  @Post('documents/:id/generate-alt-text')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  generateAltText(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer } | undefined,
    @Body() b: ImageSourceDto,
  ) {
    return this.service.generateAltText(c, id, file, b);
  }
  @Post('documents/:id/refine-image')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  refineImage(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @UploadedFile() file: { buffer: Buffer },
    @Body() b: ImageEditDto,
  ) {
    return this.service.refineImage(c, id, file, b);
  }
  @Post('documents/:id/html-check') htmlCheck(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: StageDto,
  ) {
    return this.service.htmlCheck(c, id, b.revision);
  }
  @Post('documents/:id/video-thumbnail') videoThumbnail(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: LinkPreviewDto,
  ) {
    return this.service.videoThumbnail(c, id, b.url);
  }
  @Post('documents/:id/link-preview') linkPreview(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: LinkPreviewDto,
  ) {
    return this.service.linkPreview(c, id, b.url);
  }
  @Get('library/:kind') library(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('kind') kind: string,
  ) {
    return this.service.library(c, kind === 'section' ? 'section' : 'template');
  }
  @Post('documents/:id/library') saveLibrary(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: LibraryDto,
  ) {
    return this.service.saveLibrary(c, id, b);
  }
  @Patch('library/items/:id') updateLibrary(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: UpdateLibraryDto,
  ) {
    return this.service.updateLibrary(c, id, b);
  }
  @Delete('library/items/:id') deleteLibrary(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.removeLibrary(c, id);
  }
  @Get('documents/:id/comments') comments(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.comments(c, id);
  }
  @Get('documents/:id/review') review(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.review(c, id);
  }
  @Get('documents/:id/reviewers') reviewers(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.reviewers(c, id);
  }
  @Post('documents/:id/reviewers') invite(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: ReviewerDto,
  ) {
    return this.service.inviteReviewer(c, id, b.userId, b.role);
  }
  @Post('documents/:id/invitations') inviteEmail(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: EmailInvitationDto,
  ) {
    return this.service.inviteByEmail(c, id, b);
  }
  @Delete('documents/:id/invitations/:invitationId') cancelInvitation(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.service.cancelInvitation(c, id, invitationId);
  }
  @Delete('documents/:id/reviewers/:userId') removeReviewer(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return this.service.removeReviewer(c, id, userId);
  }
  @Patch('documents/:id/review-notifications') notifications(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: NotificationDto,
  ) {
    return this.service.reviewerNotifications(c, id, b.mode);
  }
  @Post('documents/:id/comments') addComment(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: CommentDto,
  ) {
    return this.service.addComment(c, id, b);
  }
  @Get('documents/:id/thread-notifications') threadDefaults(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.threadNotifications(c, id);
  }
  @Get('documents/:id/comments/:commentId/notifications') threadNotifications(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
  ) {
    return this.service.threadNotifications(c, id, commentId);
  }
  @Patch('documents/:id/comments/:commentId/notifications') setThreadNotifications(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() b: ThreadNotificationsDto,
  ) {
    return this.service.setThreadNotifications(c, id, commentId, b.userIds);
  }
  @Patch('documents/:id/comments/:commentId') resolve(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Param('commentId') commentId: string,
    @Body() b: ResolveDto,
  ) {
    return this.service.resolveComment(c, id, commentId, b.resolved);
  }
  @Get('assets') assets(@CurrentTenant() c: WorkspaceTenantContext, @Query() q: AssetQueryDto) {
    return this.service.assets(c, q);
  }
  @Get('asset-folders') assetFolders(@CurrentTenant() c: WorkspaceTenantContext) {
    return this.service.assetFolders(c);
  }
  @Post('asset-folders') createAssetFolder(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Body() b: CreateAssetFolderDto,
  ) {
    return this.service.createAssetFolder(c, b.name, b.assetIds);
  }
  @Patch('asset-folders/:id') renameAssetFolder(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: AssetFolderDto,
  ) {
    return this.service.renameAssetFolder(c, id, b.name);
  }
  @Delete('asset-folders/:id') deleteAssetFolder(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.deleteAssetFolder(c, id);
  }
  @Post('assets/move') moveAssets(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Body() b: MoveAssetsDto,
  ) {
    return this.service.moveAssets(c, b.ids, b.folderId);
  }
  @Get('assets/:id') assetDetails(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
  ) {
    return this.service.assetDetails(c, id);
  }
  @Get('assets/:id/revisions') assetRevisions(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Query() q: ImageRevisionQueryDto,
  ) {
    return this.service.assetRevisions(c, id, q);
  }
  @Post('assets/revisions')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'file', maxCount: 1 },
        { name: 'original', maxCount: 1 },
      ],
      {
        limits: { fileSize: 10 * 1024 * 1024, files: 2 },
      },
    ),
  )
  saveImageRevision(
    @CurrentTenant() c: WorkspaceTenantContext,
    @UploadedFiles()
    files: {
      file?: { buffer: Buffer; originalname: string }[];
      original?: { buffer: Buffer; originalname: string }[];
    },
    @Body() b: ImageRevisionDto,
  ) {
    return this.service.saveImageRevision(
      c,
      files?.file?.[0],
      b.sourceToken,
      files?.original?.[0],
      b.documentId,
    );
  }
  @Patch('assets/:id') renameAsset(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() b: RenameAssetDto,
  ) {
    return this.service.renameAsset(c, id, b.name);
  }
  @Post('assets/delete') deleteAssets(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Body() b: DeleteAssetsDto,
  ) {
    return this.service.deleteAssets(c, b.ids);
  }
  @Post('assets/import') importAsset(
    @CurrentTenant() c: WorkspaceTenantContext,
    @Body() b: ImportAssetDto,
  ) {
    return this.service.importAsset(c, b.url, b.folderId);
  }
  @Post('assets')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024, files: 1 } }))
  upload(
    @CurrentTenant() c: WorkspaceTenantContext,
    @UploadedFile() file: { buffer: Buffer; originalname: string },
    @Body() b: UploadAssetDto,
  ) {
    return this.service.upload(c, file, b.folderId);
  }
}

/** Email images and uploaded fonts must be retrievable without a Capiro session.
 * Capability tokens identify immutable validated assets, not document data. */
@Controller('newsletters/assets/file')
export class NewsletterAssetController {
  constructor(private readonly service: NewsletterService) {}
  @Get(':token') async file(@Param('token') token: string, @Res() response: Response) {
    const asset = await this.service.publicAsset(token);
    response
      .set({
        'Content-Type': asset.mimeType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Security-Policy': "default-src 'none'",
      })
      .send(asset.file);
  }
}
