import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Min,
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { Transform } from 'class-transformer';
import type { TenantContext } from '@capiro/shared';
import { Roles } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { CurrentTenant } from '../tenant/current-tenant.decorator.js';
import { ClientFacilitiesService } from './client-facilities.service.js';
import { US_STATE_CODES, isValidDistrictForState } from '../common/us-congressional-districts.js';

// Bare district number ("12") or the at-large sentinel "00"; the state is
// carried separately. `/^[0-9]{1,2}$/` admits "00" already, so a single
// regex covers both the numbered-district and at-large cases.
const DISTRICT_PATTERN = /^[0-9]{1,2}$/;

// Cross-field check: a district is only valid in the context of its state
// (e.g. CA has 52 districts, so "99" is impossible). Reads the sibling `state`
// off the DTO. Skips when either field is absent — a PATCH that touches only
// one of them can't be cross-validated here.
@ValidatorConstraint({ name: 'isDistrictValidForState', async: false })
class IsDistrictValidForStateConstraint implements ValidatorConstraintInterface {
  validate(district: unknown, args: ValidationArguments): boolean {
    const state = (args.object as { state?: string }).state;
    return isValidDistrictForState(state, district == null ? null : String(district));
  }
  defaultMessage(args: ValidationArguments): string {
    const state = (args.object as { state?: string }).state;
    return `congressionalDistrict "${String(args.value)}" is not a valid district for state ${state ?? '(unknown)'}`;
  }
}
function IsDistrictValidForState(options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      target: object.constructor,
      propertyName,
      options,
      validator: IsDistrictValidForStateConstraint,
    });
  };
}

// Normalize a 2-letter state code to uppercase before validation so "ca" and
// "CA" are treated alike.
const upperState = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.toUpperCase() : value;

export class CreateFacilityDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  addressLine?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  @Transform(upperState)
  @IsIn(US_STATE_CODES, {
    message: 'state must be a valid 2-letter US state or territory code',
  })
  state?: string;

  @IsOptional()
  @IsString()
  zip?: string;

  @IsOptional()
  @IsString()
  @Matches(DISTRICT_PATTERN, {
    message: 'congressionalDistrict must be a 1-2 digit number (bare, e.g. "12" or "00")',
  })
  @IsDistrictValidForState()
  congressionalDistrict?: string;

  @IsOptional()
  @IsIn(['user', 'geocoded'])
  districtSource?: string;

  // District Impact Engine (Phase 1 M1.4) — manual fallback when the Census
  // Geocoder returns no_match/ambiguous (no map-pin-drop UI exists). Bare
  // district code, e.g. "9" or "3A" (a few states use alpha-suffixed
  // districts) — no seat-count cross-validation exists for state chambers
  // (unlike US_HOUSE_SEATS for the federal side), so only format is checked.
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,8}$/, { message: 'stateHouseDistrict must be 1-8 alphanumeric characters' })
  stateHouseDistrict?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,8}$/, { message: 'stateSenateDistrict must be 1-8 alphanumeric characters' })
  stateSenateDistrict?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  employeeCount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class UpdateFacilityDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  addressLine?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  @Transform(upperState)
  @IsIn(US_STATE_CODES, {
    message: 'state must be a valid 2-letter US state or territory code',
  })
  state?: string;

  @IsOptional()
  @IsString()
  zip?: string;

  @IsOptional()
  @IsString()
  @Matches(DISTRICT_PATTERN, {
    message: 'congressionalDistrict must be a 1-2 digit number (bare, e.g. "12" or "00")',
  })
  @IsDistrictValidForState()
  congressionalDistrict?: string;

  @IsOptional()
  @IsIn(['user', 'geocoded'])
  districtSource?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,8}$/, { message: 'stateHouseDistrict must be 1-8 alphanumeric characters' })
  stateHouseDistrict?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9-]{1,8}$/, { message: 'stateSenateDistrict must be 1-8 alphanumeric characters' })
  stateSenateDistrict?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  employeeCount?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

@Controller('clients/:clientId/facilities')
@UseGuards(RolesGuard)
@Roles('standard_user')
export class ClientFacilitiesController {
  constructor(private readonly service: ClientFacilitiesService) {}

  @Get()
  listFacilities(@CurrentTenant() ctx: TenantContext, @Param('clientId') clientId: string) {
    return this.service.listFacilities(ctx, clientId);
  }

  @Post()
  createFacility(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Body() body: CreateFacilityDto,
  ) {
    return this.service.createFacility(ctx, clientId, body);
  }

  @Patch(':id')
  updateFacility(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
    @Body() body: UpdateFacilityDto,
  ) {
    return this.service.updateFacility(ctx, clientId, id, body);
  }

  @Delete(':id')
  deleteFacility(
    @CurrentTenant() ctx: TenantContext,
    @Param('clientId') clientId: string,
    @Param('id') id: string,
  ) {
    return this.service.deleteFacility(ctx, clientId, id);
  }
}
