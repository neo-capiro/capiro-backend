import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export interface TemplateView {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  product: string;
  style: string | null;
  fontFamily: string | null;
  accentColor: string | null;
  meriPrimary: boolean;
  meriSecondary: boolean;
  elements: string[];
  sections: string[];
}

/**
 * Template catalog service (Phase 3, AC-3.2). Reads ws_template. Global
 * templates (tenantId null) plus any tenant-authored templates are returned;
 * Meri's suggestion = the primary + secondary for the active product.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Templates for a product, split into Meri's primary/secondary + all. */
  async forProduct(
    tenantId: string,
    product: string,
  ): Promise<{
    primary: TemplateView | null;
    secondary: TemplateView | null;
    all: TemplateView[];
  }> {
    const rows = await this.prisma.wsTemplate.findMany({
      where: {
        product,
        OR: [{ tenantId: null }, { tenantId }],
      },
      orderBy: [{ meriPrimary: 'desc' }, { meriSecondary: 'desc' }, { name: 'asc' }],
    });
    const all = rows.map(toView);
    return {
      primary: all.find((t) => t.meriPrimary) ?? null,
      secondary: all.find((t) => t.meriSecondary) ?? null,
      all,
    };
  }

  /**
   * The FULL tenant-visible template library (every product), for the Setup
   * "Search all templates" box. Global templates (tenantId null) + this tenant's
   * own. Not product-filtered — the picker's two recommendations still come from
   * forProduct(); search spans the whole catalog.
   */
  async list(tenantId: string): Promise<TemplateView[]> {
    const rows = await this.prisma.wsTemplate.findMany({
      where: { OR: [{ tenantId: null }, { tenantId }] },
      orderBy: [{ product: 'asc' }, { name: 'asc' }],
    });
    return rows.map(toView);
  }

  /** Full ordered sections for a single template (preview pane). */
  async byId(tenantId: string, id: string): Promise<TemplateView> {
    const row = await this.prisma.wsTemplate.findFirst({
      where: { id, OR: [{ tenantId: null }, { tenantId }] },
    });
    if (!row) throw new NotFoundException('Template not found');
    return toView(row);
  }
}

function toView(row: {
  id: string;
  name: string;
  icon: string | null;
  description: string | null;
  product: string;
  style: string | null;
  fontFamily: string | null;
  accentColor: string | null;
  meriPrimary: boolean;
  meriSecondary: boolean;
  elements: string[];
  sections: string[];
}): TemplateView {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    description: row.description,
    product: row.product,
    style: row.style,
    fontFamily: row.fontFamily,
    accentColor: row.accentColor,
    meriPrimary: row.meriPrimary,
    meriSecondary: row.meriSecondary,
    elements: row.elements,
    sections: row.sections,
  };
}
