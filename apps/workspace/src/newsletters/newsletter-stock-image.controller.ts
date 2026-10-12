import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { TenantGuard } from '../auth/tenant.guard.js';
import { CurrentTenant } from '../auth/current-tenant.decorator.js';
import type { WorkspaceTenantContext } from '../auth/tenant-context.js';
import { NewsletterService } from './newsletter.service.js';
import { NewsletterStockImageService } from './newsletter-stock-image.service.js';

class StockQueryDto {
  @IsOptional() @IsString() @MaxLength(100) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10_000) page?: number;
}
class StockImportDto {}

@Controller('newsletters/stock-images')
@UseGuards(TenantGuard)
export class NewsletterStockImageController {
  constructor(
    private readonly stock: NewsletterStockImageService,
    private readonly newsletters: NewsletterService,
  ) {}
  @Get('status') status() {
    return this.stock.status();
  }
  @Get() search(@Query() query: StockQueryDto) {
    return this.stock.search(query.search, query.page);
  }
  @Post(':id/import') async import(
    @CurrentTenant() ctx: WorkspaceTenantContext,
    @Param('id') id: string,
    @Body() _body: StockImportDto,
  ) {
    // Resolve the ID again server-side; callers cannot choose a download URL.
    const image = await this.stock.get(id);
    const asset = await this.newsletters.importAsset(ctx, image.imageUrl);
    return { ...asset, altText: image.title };
  }
}
