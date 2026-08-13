// Delivery Service — coordinates approval + share-link services.

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CollaboratorsService } from '../collaborators/collaborators.service.js';
import { ApprovalService } from './approval.service.js';
import { ShareLinkService } from './share-link.service.js';

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly collaborators: CollaboratorsService,
    private readonly approval: ApprovalService,
    private readonly shareLink: ShareLinkService,
  ) {}

  get approvalService() { return this.approval; }
  get shareLinkService() { return this.shareLink; }
}
