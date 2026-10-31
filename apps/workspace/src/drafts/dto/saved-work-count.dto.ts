import { IsOptional, IsUUID } from 'class-validator';

export class SavedWorkCountQueryDto {
  @IsOptional() @IsUUID() clientId?: string;
}

export interface SavedWorkCount {
  metric: 'workspace.saved-work-products';
  version: 1;
  scope: { kind: 'actor'; clientId: null } | { kind: 'client'; clientId: string };
  count: number;
  observationStartedAt: string;
  observedAt: string;
  complete: true;
  capped: false;
}
