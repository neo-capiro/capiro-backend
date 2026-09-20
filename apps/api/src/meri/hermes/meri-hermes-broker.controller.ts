/**
 * Worker-facing broker routes. Mounted under /api/internal (excluded from the
 * tenant-context middleware by design) and guarded by the scope-bound worker
 * token + run binding, never by a browser JWT and never by the platform-wide
 * INTERNAL_SERVICE_SECRET.
 */
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import type { Request } from 'express';
import { MeriHermesBrokerService, type MeriHermesBrokerAuth } from './meri-hermes-broker.service.js';

type BrokerRequest = Request & { meriHermesBrokerAuth?: MeriHermesBrokerAuth };

@Injectable()
export class MeriHermesWorkerTokenGuard implements CanActivate {
  constructor(private readonly broker: MeriHermesBrokerService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<BrokerRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() ?? null : null;
    const runHeader = request.headers['x-meri-hermes-run-id'];
    const hermesRunId = typeof runHeader === 'string' ? runHeader.trim() : null;
    if (!token) throw new UnauthorizedException({ code: 'missing_worker_token' });
    request.meriHermesBrokerAuth = await this.broker.authorize(token, hermesRunId);
    return true;
  }
}

class RecallDto {
  @IsString() @Length(1, 4000) query!: string;
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsInt() @Min(1) @Max(50) limit?: number;
}

class ProposeMemoryDto {
  @IsString() @Length(1, 200) key!: string;
  @IsString() @Length(1, 8000) value!: string;
  @IsIn(['user_private', 'firm', 'client']) scope!: 'user_private' | 'firm' | 'client';
  @IsOptional() @IsUUID() clientId?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) confidence?: number;
  @IsOptional() @IsString() @Length(0, 1000) sourceExcerpt?: string;
}

class PublishArtifactDto {
  @IsString() @Length(1, 200) title!: string;
  @IsString() @Length(1, 60) kind!: string;
  @IsOptional() @IsString() @Length(1, 120) contentType?: string;
  @IsOptional() @IsString() @Length(1, 300) filename?: string;
  @IsOptional() @IsString() @Length(0, 200_000) bodyText?: string;
  @IsOptional() @IsString() @Length(0, 3_000_000) dataBase64?: string;
}

class ClarificationDto {
  @IsString() @Length(1, 2000) question!: string;
  @IsOptional() @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) choices?: string[];
  @IsOptional() @IsBoolean() multiSelect?: boolean;
}

class RecordTurnDto {
  @IsOptional() @IsInt() @Min(0) userChars?: number;
  @IsOptional() @IsInt() @Min(0) assistantChars?: number;
}

function authOf(request: BrokerRequest): MeriHermesBrokerAuth {
  const auth = request.meriHermesBrokerAuth;
  if (!auth) throw new UnauthorizedException({ code: 'missing_worker_token' });
  return auth;
}

@Controller('internal/hermes/broker')
@UseGuards(MeriHermesWorkerTokenGuard)
export class MeriHermesBrokerController {
  constructor(private readonly broker: MeriHermesBrokerService) {}

  @Get('whoami')
  whoami(@Req() request: BrokerRequest) {
    return this.broker.whoami(authOf(request));
  }

  @Post('memory/recall')
  recall(@Req() request: BrokerRequest, @Body() body: RecallDto) {
    return this.broker.recall(authOf(request), body);
  }

  @Post('memory/propose')
  propose(@Req() request: BrokerRequest, @Body() body: ProposeMemoryDto) {
    return this.broker.proposeMemory(authOf(request), body);
  }

  @Get('attachments/:attachmentId')
  attachment(@Req() request: BrokerRequest, @Param('attachmentId', ParseUUIDPipe) attachmentId: string) {
    return this.broker.getAttachment(authOf(request), attachmentId);
  }

  @Post('artifacts')
  publish(@Req() request: BrokerRequest, @Body() body: PublishArtifactDto) {
    return this.broker.publishArtifact(authOf(request), body);
  }

  @Post('clarifications')
  clarify(@Req() request: BrokerRequest, @Body() body: ClarificationDto) {
    return this.broker.requestClarification(authOf(request), body);
  }

  @Post('turns')
  recordTurn(@Req() request: BrokerRequest, @Body() body: RecordTurnDto) {
    return this.broker.recordTurn(authOf(request), body);
  }
}
