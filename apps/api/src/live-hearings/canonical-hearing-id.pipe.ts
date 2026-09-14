import { Injectable, type PipeTransform } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { resolveCanonicalHearingId } from '../hearing-discovery/hearing-alias.js';

/** Only hearing-ID route parameters use this pipe, never committee/capture IDs. */
@Injectable()
export class CanonicalHearingIdPipe implements PipeTransform<string, Promise<string>> {
  constructor(private readonly prisma: PrismaService) {}
  transform(id: string): Promise<string> {
    return resolveCanonicalHearingId(this.prisma, id);
  }
}
