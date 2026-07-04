import { Controller, Get, UseGuards } from '@nestjs/common';
import { ISSUE_AREAS } from '@capiro/shared';
import { TenantGuard } from '../auth/tenant.guard.js';

/**
 * Capiro-managed issue-area taxonomy for the Configure checkboxes (P1.1 aux
 * port of legacy `GET /api/intelligence/issue-areas`).
 *
 * Mounted at `/intel-api/tracker/issue-areas` — no collision with the
 * `/intel-api/tracker/watchlists/*` controller. DELIBERATELY TenantGuard-only
 * (no TrackerOwnerGuard): the list is a static, tenant-independent constant,
 * and a 404-when-unflagged here would break the Configure UI during a partial
 * cutover. Legacy shape `{ issueAreas: string[] }`, no adapter.
 */
@Controller('tracker')
@UseGuards(TenantGuard)
export class TrackerTaxonomyController {
  @Get('issue-areas')
  issueAreas() {
    return { issueAreas: ISSUE_AREAS };
  }
}
