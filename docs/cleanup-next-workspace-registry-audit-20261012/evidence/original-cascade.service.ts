import { Injectable } from '@nestjs/common';
import { WSC, SECTION_LIBRARY, type IndustryDatum } from './cascade.config.js';

/**
 * Thin service wrapper around the ported cascade config (cascade.config.ts).
 * Keeps the controller free of static-data imports and gives us a seam for
 * future per-tenant catalog overrides (open question #8: real product catalog).
 */
@Injectable()
export class CascadeService {
  industries(): string[] {
    return WSC.industries();
  }

  productsFor(industry: string): string[] {
    return WSC.productsFor(industry);
  }

  allLibraryProducts(): string[] {
    return WSC.allLibraryProducts();
  }

  pathwaysFor(industry: string, product: string): string[] {
    return WSC.pathwaysFor(industry, product);
  }

  committeesFor(industry: string, pathways: string[]): string[] {
    return WSC.committeesFor(industry, pathways);
  }

  /** Platform data rows for an industry (INDUSTRY_DATA), toggled into cfg.linkedData. */
  dataFor(industry: string): IndustryDatum[] {
    return WSC.dataFor(industry);
  }

  /** The shared "add from library" section names for OwnSectionBuilder. */
  sectionLibrary(): string[] {
    return SECTION_LIBRARY.slice();
  }

  defaultsFor(product: string): {
    product: string;
    personalize: boolean;
    officeAssociated: boolean;
    coverLetter: boolean;
    sections: string[];
    pages: number;
    funding: boolean;
    icon: string;
    description: string;
  } {
    const meta = WSC.meta(product);
    return {
      product,
      personalize: meta.personalize,
      // Personalization sub-questions always default to No — keep this seed
      // endpoint consistent with the create() default (never re-default to Yes).
      officeAssociated: false,
      coverLetter: meta.cover,
      sections: WSC.suggestedSections(product),
      pages: WSC.suggestedPages(product),
      funding: WSC.isFunding(product),
      icon: meta.icon,
      description: meta.desc,
    };
  }
}
