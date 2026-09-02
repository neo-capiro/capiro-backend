import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsString } from 'class-validator';
import { InternalServiceGuard } from '../auth/internal-service.guard.js';
import { DirectoryService, type DirectoryMemberContext } from './directory.service.js';

class MatchEmailsDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) emails!: string[];
}

/**
 * Backend-only Directory reads for the Hill Day workflow in apps/workspace.
 * That service runs an async generation job that outlives any browser-held
 * Clerk JWT, and the LegiStorm snapshot exists only in this service's cache,
 * so it resolves attendee addresses here over the shared service secret
 * (InternalServiceGuard: fail-closed, never a user JWT). Read-only.
 *
 * Lives under /api/internal, which the tenant-context middleware excludes by
 * design — the Directory is global public-record data, not tenant data.
 */
@Controller('internal/directory')
@UseGuards(InternalServiceGuard)
export class InternalDirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Post('match-emails')
  @HttpCode(200)
  async matchEmails(@Body() body: MatchEmailsDto) {
    const emails = [...new Set(body.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const [matches, committeeStaff] = await Promise.all([
      this.directory.findContactsByEmails(emails, 500),
      this.directory.findCommitteeStaffByEmails(emails, 500),
    ]);
    const contexts = new Map<string, DirectoryMemberContext | null>();
    const contextFor = async (memberId: string) => {
      if (!contexts.has(memberId)) {
        contexts.set(memberId, await this.directory.getMemberContextById(memberId));
      }
      return contexts.get(memberId) ?? null;
    };
    const enriched = [];
    for (const m of matches) {
      const context = await contextFor(m.member.id);
      if (!context) continue;
      const rosterEntry = m.staff ? context.staff.find((s) => s.id === m.staff?.id) : null;
      enriched.push({
        attendeeEmail: m.attendeeEmail,
        matchKind: m.matchKind,
        directoryContactId: m.directoryContactId,
        directoryContactName: m.directoryContactName,
        member: context,
        staff: m.staff
          ? {
              id: m.staff.id,
              fullName: m.staff.fullName,
              title: m.staff.title,
              email: m.staff.email,
              officeLocation: m.staff.officeLocation,
              issueAreas: m.staff.issueAreas,
              roles: m.staff.roles,
              isCurrent: rosterEntry?.isCurrent ?? true,
            }
          : null,
      });
    }
    return { snapshotId: 'directory', matches: enriched, committeeStaff };
  }

  @Get('contacts')
  async contacts(
    @Query('q') q?: string,
    @Query('chamber') chamber?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const limit = Number.parseInt(pageSize ?? '10', 10);
    return {
      contacts: await this.directory.searchMemberContexts(
        q ?? '',
        chamber,
        Number.isFinite(limit) ? limit : 10,
      ),
    };
  }

  @Get('members/:memberId')
  async member(@Param('memberId') memberId: string) {
    return { context: await this.directory.getMemberContextById(memberId) };
  }

  @Get('staffers')
  async staffers(@Query('q') q?: string, @Query('pageSize') pageSize?: string) {
    const limit = Number.parseInt(pageSize ?? '12', 10);
    if (!q?.trim()) return { staffers: [] };
    return {
      staffers: await this.directory.searchStafferContexts(q, Number.isFinite(limit) ? limit : 12),
    };
  }

  @Get('staffers/:staffId')
  async staffer(@Param('staffId') staffId: string) {
    return { staffer: await this.directory.getStafferContextById(staffId) };
  }
}
