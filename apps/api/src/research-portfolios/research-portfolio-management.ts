import {
  researchPortfolioSavedComparisonActions,
  executeResearchPortfolioSavedComparison,
} from './research-portfolio-saved-comparison-tools.js';
import type { DefenseSavedComparisonsService } from '../defense-research/defense-saved-comparisons.service.js';
import { BadRequestException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { ResearchPortfoliosService } from './research-portfolios.service.js';
import type { ResearchPortfolioAnalyticsService } from './research-portfolio-analytics.service.js';
import type { ResearchPortfolioChangesService } from './research-portfolio-changes.service.js';
import type { ResearchPortfolioOutputService } from './research-portfolio-output.service.js';
import type { ResearchPortfolioReviewService } from './research-portfolio-review.service.js';
import type { ResearchPortfolioRulesService } from './research-portfolio-rules.service.js';
import type { ResearchPortfolioPhase11Service } from './research-portfolio-phase11.service.js';
import type { ResearchPortfolioImportService } from './research-portfolio-import.service.js';

type NativeServices = {
  portfolios: ResearchPortfoliosService;
  analytics: ResearchPortfolioAnalyticsService;
  changes: ResearchPortfolioChangesService;
  outputs: ResearchPortfolioOutputService;
  reviews: ResearchPortfolioReviewService;
  rules: ResearchPortfolioRulesService;
  phase11: ResearchPortfolioPhase11Service;
  imports?: ResearchPortfolioImportService;
  savedComparisons?: DefenseSavedComparisonsService;
};
type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: readonly unknown[];
  format?: string;
  anyOf?: readonly Schema[];
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions = {
  ...researchPortfolioSavedComparisonActions,
  portfolio_create: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      purpose: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
      mode: {
        type: 'string',
        enum: ['manual', 'rules', 'hybrid'],
      },
    },
    required: ['idempotencyKey', 'name'],
    readOnly: false,
    ids: [],
  },
  portfolio_update: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      purpose: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
      mode: {
        type: 'string',
        enum: ['manual', 'rules', 'hybrid'],
      },
    },
    required: ['idempotencyKey', 'expectedRevision'],
    readOnly: false,
    ids: [],
  },
  portfolio_archive: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
    },
    required: ['idempotencyKey', 'expectedRevision'],
    readOnly: false,
    ids: [],
  },
  portfolio_restore: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
    },
    required: ['idempotencyKey', 'expectedRevision'],
    readOnly: false,
    ids: [],
  },
  grants_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  client_links_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  members_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  grant_upsert: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      principalUserId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      principalType: {
        type: 'string',
        enum: ['user'],
      },
      role: {
        type: 'string',
        enum: ['owner', 'editor', 'viewer'],
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'principalUserId', 'principalType', 'role'],
    readOnly: false,
    ids: ['principalUserId'],
  },
  grant_delete: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      principalUserId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'principalUserId'],
    readOnly: false,
    ids: ['principalUserId'],
  },
  client_link_create: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      clientId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'clientId'],
    readOnly: false,
    ids: [],
  },
  client_link_delete: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      clientId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'clientId'],
    readOnly: false,
    ids: ['clientId'],
  },
  member_create: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      targetKind: {
        type: 'string',
        enum: ['program', 'program_element', 'project', 'budget_line', 'award'],
      },
      targetId: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      label: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
      unresolvedInput: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: true,
          },
          {
            type: 'null',
          },
        ],
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'targetKind', 'targetId'],
    readOnly: false,
    ids: [],
  },
  members_decide: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      decisions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            memberId: {
              type: 'string',
              minLength: 1,
              maxLength: 36,
              format: 'uuid',
            },
            disposition: {
              type: 'string',
              enum: ['included', 'excluded'],
            },
            reason: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
            },
          },
          required: ['memberId', 'disposition', 'reason'],
          additionalProperties: false,
        },
        maxItems: 100,
        minItems: 1,
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'decisions'],
    readOnly: false,
    ids: [],
  },
  member_resolve: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      memberId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      targetKind: {
        type: 'string',
        enum: ['program', 'program_element', 'project', 'budget_line', 'award'],
      },
      targetId: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      label: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'memberId', 'targetKind', 'targetId'],
    readOnly: false,
    ids: ['memberId'],
  },
  rule_preview: {
    properties: {
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      schemaVersion: {
        type: 'integer',
        enum: [1],
      },
      expression: {
        type: 'object',
        additionalProperties: true,
      },
      readableExpression: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      mode: {
        type: 'string',
        enum: ['rules', 'hybrid'],
      },
      qualificationPolicy: {
        type: 'object',
        additionalProperties: true,
      },
      taxonomyVersionId: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 36,
            format: 'uuid',
          },
          {
            type: 'null',
          },
        ],
      },
      templateVersionId: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 36,
            format: 'uuid',
          },
          {
            type: 'null',
          },
        ],
      },
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            targetKind: {
              type: 'string',
              enum: ['program', 'program_element', 'project', 'budget_line', 'award'],
            },
            targetId: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
            },
            label: {
              anyOf: [
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                },
                {
                  type: 'null',
                },
              ],
            },
            facts: {
              type: 'object',
              additionalProperties: true,
            },
            completeness: {
              type: 'string',
              enum: [
                'complete',
                'partial',
                'unavailable',
                'unresolved',
                'insufficient_qualification',
              ],
            },
            unknownReasons: {
              type: 'array',
              items: {
                type: 'string',
                minLength: 1,
                maxLength: 2000,
              },
              maxItems: 100,
              minItems: 0,
            },
          },
          required: ['targetKind', 'targetId', 'facts'],
          additionalProperties: false,
        },
        maxItems: 5000,
        minItems: 0,
      },
    },
    required: [
      'expectedRevision',
      'schemaVersion',
      'expression',
      'readableExpression',
      'mode',
      'qualificationPolicy',
      'candidates',
    ],
    readOnly: true,
    ids: [],
  },
  rule_publish: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      previewId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      previewHash: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'previewId', 'previewHash'],
    readOnly: false,
    ids: [],
  },
  review_assign: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      reviewId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      expectedPortfolioRevision: {
        type: 'integer',
        minimum: 0,
      },
      assigneeUserId: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 36,
            format: 'uuid',
          },
          {
            type: 'null',
          },
        ],
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
    },
    required: [
      'idempotencyKey',
      'expectedRevision',
      'reviewId',
      'expectedPortfolioRevision',
      'assigneeUserId',
      'reason',
    ],
    readOnly: false,
    ids: ['reviewId'],
  },
  review_decide: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      decisionType: {
        type: 'string',
        enum: ['include', 'exclude', 'defer', 'reopen', 'dispute'],
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      evidenceFor: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceRevisionId: {
              type: 'string',
              minLength: 1,
              maxLength: 36,
              format: 'uuid',
            },
            locator: {
              type: 'object',
              additionalProperties: true,
            },
            quote: {
              anyOf: [
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                },
                {
                  type: 'null',
                },
              ],
            },
            stance: {
              type: 'string',
              enum: ['for', 'against'],
            },
          },
          required: ['sourceRevisionId', 'locator', 'quote', 'stance'],
          additionalProperties: false,
        },
        maxItems: 100,
        minItems: 0,
      },
      evidenceAgainst: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            sourceRevisionId: {
              type: 'string',
              minLength: 1,
              maxLength: 36,
              format: 'uuid',
            },
            locator: {
              type: 'object',
              additionalProperties: true,
            },
            quote: {
              anyOf: [
                {
                  type: 'string',
                  minLength: 1,
                  maxLength: 2000,
                },
                {
                  type: 'null',
                },
              ],
            },
            stance: {
              type: 'string',
              enum: ['for', 'against'],
            },
          },
          required: ['sourceRevisionId', 'locator', 'quote', 'stance'],
          additionalProperties: false,
        },
        maxItems: 100,
        minItems: 0,
      },
      reviewId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      expectedPortfolioRevision: {
        type: 'integer',
        minimum: 0,
      },
      priorDecisionId: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 36,
            format: 'uuid',
          },
          {
            type: 'null',
          },
        ],
      },
    },
    required: [
      'idempotencyKey',
      'expectedRevision',
      'reviewId',
      'expectedPortfolioRevision',
      'decisionType',
      'reason',
    ],
    readOnly: false,
    ids: ['reviewId'],
  },
  reviews_bulk_decide: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            expectedRevision: {
              type: 'integer',
              minimum: 0,
            },
            decisionType: {
              type: 'string',
              enum: ['include', 'exclude', 'defer', 'reopen', 'dispute'],
            },
            reason: {
              type: 'string',
              minLength: 1,
              maxLength: 2000,
            },
            evidenceFor: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sourceRevisionId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 36,
                    format: 'uuid',
                  },
                  locator: {
                    type: 'object',
                    additionalProperties: true,
                  },
                  quote: {
                    anyOf: [
                      {
                        type: 'string',
                        minLength: 1,
                        maxLength: 2000,
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  stance: {
                    type: 'string',
                    enum: ['for', 'against'],
                  },
                },
                required: ['sourceRevisionId', 'locator', 'quote', 'stance'],
                additionalProperties: false,
              },
              maxItems: 100,
              minItems: 0,
            },
            evidenceAgainst: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  sourceRevisionId: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 36,
                    format: 'uuid',
                  },
                  locator: {
                    type: 'object',
                    additionalProperties: true,
                  },
                  quote: {
                    anyOf: [
                      {
                        type: 'string',
                        minLength: 1,
                        maxLength: 2000,
                      },
                      {
                        type: 'null',
                      },
                    ],
                  },
                  stance: {
                    type: 'string',
                    enum: ['for', 'against'],
                  },
                },
                required: ['sourceRevisionId', 'locator', 'quote', 'stance'],
                additionalProperties: false,
              },
              maxItems: 100,
              minItems: 0,
            },
            reviewId: {
              type: 'string',
              minLength: 1,
              maxLength: 36,
              format: 'uuid',
            },
          },
          required: ['reviewId', 'expectedRevision', 'decisionType', 'reason'],
          additionalProperties: false,
        },
        maxItems: 50,
        minItems: 1,
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'items'],
    readOnly: false,
    ids: [],
  },
  annual_review_get: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  annual_review_refresh: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      asOfFiscalYear: {
        type: 'integer',
        minimum: 0,
      },
      knownAt: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      decisionIds: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 36,
          format: 'uuid',
        },
        maxItems: 100,
        minItems: 0,
      },
    },
    required: ['idempotencyKey', 'expectedRevision'],
    readOnly: false,
    ids: [],
  },
  annual_review_reopen: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      continuityIds: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 36,
          format: 'uuid',
        },
        maxItems: 100,
        minItems: 1,
      },
      reason: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'continuityIds'],
    readOnly: false,
    ids: [],
  },
  import_create: {
    properties: {
      operationKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      worksheetKind: {
        type: 'string',
        enum: ['membership', 'rules', 'reviews'],
      },
      fileName: {
        type: 'string',
        minLength: 1,
        maxLength: 255,
      },
      mediaType: {
        type: 'string',
        enum: ['text/csv', 'application/vnd.ms-excel'],
      },
      contentBase64: {
        type: 'string',
        minLength: 1,
        maxLength: 12000000,
      },
      schemaVersion: {
        type: 'string',
        enum: ['membership-v1', 'rules-v1', 'reviews-v1'],
      },
      mapping: {
        type: 'object',
        additionalProperties: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
        },
      },
    },
    required: [
      'operationKey',
      'expectedRevision',
      'worksheetKind',
      'fileName',
      'mediaType',
      'contentBase64',
      'schemaVersion',
      'mapping',
    ],
    readOnly: false,
    ids: [],
  },
  import_action: {
    properties: {
      jobId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      importAction: {
        type: 'string',
        enum: ['preview', 'apply', 'pause', 'resume', 'cancel', 'retry', 'reconcile', 'compensate'],
      },
      operationKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      selectedRowIds: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 36,
          format: 'uuid',
        },
        maxItems: 10000,
        minItems: 0,
      },
      repairs: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          additionalProperties: true,
        },
      },
      compensationPreviewHash: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
    },
    required: ['jobId', 'importAction', 'operationKey'],
    readOnly: false,
    ids: ['jobId', 'importAction'],
  },
  subscriptions_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  deliveries_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  subscription_update: {
    properties: {
      subscriptionId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      active: {
        type: 'boolean',
      },
      channel: {
        type: 'string',
        enum: ['in_app', 'email'],
      },
      cadence: {
        type: 'string',
        enum: ['immediate', 'daily', 'weekly'],
      },
    },
    required: ['subscriptionId'],
    readOnly: false,
    ids: ['subscriptionId'],
  },
  bookmark_update: {
    properties: {
      bookmarkId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      label: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
      note: {
        anyOf: [
          {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
          },
          {
            type: 'null',
          },
        ],
      },
    },
    required: ['bookmarkId'],
    readOnly: false,
    ids: ['bookmarkId'],
  },
  bookmark_delete: {
    properties: {
      bookmarkId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['bookmarkId'],
    readOnly: false,
    ids: ['bookmarkId'],
  },
  fit_refresh: {
    properties: {},
    required: [],
    readOnly: false,
    ids: [],
  },
  watch_conversion_preview: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  watch_conversion_apply: {
    properties: {
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
      expectedRevision: {
        type: 'integer',
        minimum: 0,
      },
      previewHash: {
        type: 'string',
        minLength: 1,
        maxLength: 2000,
      },
      selectedWatchIds: {
        type: 'array',
        items: {
          type: 'string',
          minLength: 1,
          maxLength: 36,
          format: 'uuid',
        },
        maxItems: 1000,
        minItems: 1,
      },
    },
    required: ['idempotencyKey', 'expectedRevision', 'previewHash', 'selectedWatchIds'],
    readOnly: false,
    ids: [],
  },
  output_get: {
    properties: {
      jobId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['jobId'],
    readOnly: true,
    ids: ['jobId'],
  },
  output_cancel: {
    properties: {
      jobId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['jobId'],
    readOnly: false,
    ids: ['jobId'],
  },
  output_retry: {
    properties: {
      jobId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['jobId'],
    readOnly: false,
    ids: ['jobId'],
  },
  output_reconcile: {
    properties: {
      jobId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['jobId'],
    readOnly: false,
    ids: ['jobId'],
  },
  snapshots_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  snapshot_get: {
    properties: {
      snapshotId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['snapshotId'],
    readOnly: true,
    ids: ['snapshotId'],
  },
  taxonomy_get: {
    properties: {
      version: {
        type: 'integer',
        minimum: 0,
      },
    },
    required: [],
    readOnly: true,
    ids: [],
  },
  templates_list: {
    properties: {},
    required: [],
    readOnly: true,
    ids: [],
  },
  template_version_get: {
    properties: {
      templateId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
      versionId: {
        type: 'string',
        minLength: 1,
        maxLength: 36,
        format: 'uuid',
      },
    },
    required: ['templateId', 'versionId'],
    readOnly: true,
    ids: ['templateId', 'versionId'],
  },
  operation_reconcile: {
    properties: {
      operationId: {
        type: 'string',
        format: 'uuid',
      },
      operationKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
      },
    },
    required: ['operationId'],
    readOnly: false,
    ids: ['operationId'],
  },
} as const;
export const researchPortfolioManagementActions = Object.keys(actions);
export const researchPortfolioManagementSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: { type: 'string', format: 'uuid' },
    action: { type: 'string', enum: Object.keys(actions) },
    parameters: { type: 'object' },
    confirmed: { type: 'boolean', enum: [true] },
  },
  required: ['conversationId', 'action', 'parameters'],
  oneOf: Object.entries(actions).map(([action, spec]) => ({
    type: 'object',
    additionalProperties: false,
    properties: {
      conversationId: { type: 'string', format: 'uuid' },
      action: { type: 'string', enum: [action] },
      confirmed: { type: 'boolean', enum: [true] },
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: spec.properties,
        required: spec.required,
      },
    },
    required: ['conversationId', 'action', 'parameters', ...(spec.readOnly ? [] : ['confirmed'])],
  })),
};

function validate(schema: Schema, value: unknown, path: string, depth = 0): void {
  if (depth > 24) throw new BadRequestException('Management input nesting is too deep');
  if (schema.anyOf) {
    for (const option of schema.anyOf) {
      try {
        validate(option, value, path, depth + 1);
        return;
      } catch {}
    }
    throw new BadRequestException(path + ' has an invalid value');
  }
  if (schema.enum && !schema.enum.includes(value))
    throw new BadRequestException(path + ' is not an allowed value');
  if (schema.type === 'null') {
    if (value !== null) throw new BadRequestException(path + ' must be null');
    return;
  }
  if (schema.type === 'string') {
    if (
      typeof value !== 'string' ||
      value.length < (schema.minLength ?? 0) ||
      value.length > (schema.maxLength ?? Infinity) ||
      (schema.format === 'uuid' && !UUID.test(value))
    )
      throw new BadRequestException(path + ' must be a valid string');
    return;
  }
  if (schema.type === 'integer') {
    if (
      !Number.isInteger(value) ||
      (value as number) < (schema.minimum ?? -Infinity) ||
      (value as number) > (schema.maximum ?? Infinity)
    )
      throw new BadRequestException(path + ' must be a valid integer');
    return;
  }
  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new BadRequestException(path + ' must be boolean');
    return;
  }
  if (schema.type === 'array') {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new BadRequestException(path + ' must be a bounded array');
    for (const item of value) validate(schema.items ?? {}, item, path + '[]', depth + 1);
    return;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new BadRequestException(path + ' must be an object');
    const object = value as Record<string, unknown>;
    for (const required of schema.required ?? [])
      if (!(required in object))
        throw new BadRequestException(path + '.' + required + ' is required');
    for (const [key, item] of Object.entries(object)) {
      if (
        [
          '__proto__',
          'prototype',
          'constructor',
          'tenantId',
          'userId',
          'portfolioId',
          'researchPortfolioId',
          'scopeVersion',
        ].includes(key)
      )
        throw new BadRequestException(path + '.' + key + ' is controlled by the server');
      const known = schema.properties?.[key];
      if (known) validate(known, item, path + '.' + key, depth + 1);
      else if (schema.additionalProperties === false)
        throw new BadRequestException(path + '.' + key + ' is not supported');
      else if (typeof schema.additionalProperties === 'object')
        validate(schema.additionalProperties, item, path + '.' + key, depth + 1);
      else if (item && typeof item === 'object')
        validate(
          Array.isArray(item)
            ? { type: 'array', items: {} }
            : { type: 'object', additionalProperties: true },
          item,
          path + '.' + key,
          depth + 1,
        );
    }
    return;
  }
}

/** No alternate context, provider or scope mutation. Native domain services own policy and receipts. */
export async function executeResearchPortfolioManagement(
  services: NativeServices,
  ctx: TenantContext,
  portfolioId: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const validated = parseResearchPortfolioManagementInput(input);
  const action = validated.action as keyof typeof actions;
  const spec = actions[action];
  const p = validated.parameters as Record<string, unknown>;
  const dto: unknown = Object.fromEntries(
    Object.entries(p).filter(([key]) => !(spec.ids as readonly string[]).includes(key)),
  );
  if (action.startsWith('import_') && !services.imports)
    throw new BadRequestException('Research Portfolio import service is unavailable');
  if (Object.prototype.hasOwnProperty.call(researchPortfolioSavedComparisonActions, action))
    return executeResearchPortfolioSavedComparison(
      services.savedComparisons,
      ctx,
      portfolioId,
      action as keyof typeof researchPortfolioSavedComparisonActions,
      p,
    );
  switch (action) {
    case 'portfolio_create':
      return services.portfolios.create(
        ctx,
        dto as Parameters<NativeServices['portfolios']['create']>[1],
      );
    case 'portfolio_update':
      return services.portfolios.update(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['update']>[2],
      );
    case 'portfolio_archive':
      return services.portfolios.archive(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['archive']>[2],
      );
    case 'portfolio_restore':
      return services.portfolios.restore(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['restore']>[2],
      );
    case 'grants_list':
      return services.portfolios.listGrants(ctx, portfolioId);
    case 'client_links_list':
      return services.portfolios.listClientLinks(ctx, portfolioId);
    case 'members_list':
      return services.portfolios.listMembers(ctx, portfolioId);
    case 'grant_upsert':
      return services.portfolios.upsertGrant(
        ctx,
        portfolioId,
        p.principalUserId as string,
        dto as Parameters<NativeServices['portfolios']['upsertGrant']>[3],
      );
    case 'grant_delete':
      return services.portfolios.deleteGrant(
        ctx,
        portfolioId,
        p.principalUserId as string,
        dto as Parameters<NativeServices['portfolios']['deleteGrant']>[3],
      );
    case 'client_link_create':
      return services.portfolios.createClientLink(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['createClientLink']>[2],
      );
    case 'client_link_delete':
      return services.portfolios.deleteClientLink(
        ctx,
        portfolioId,
        p.clientId as string,
        dto as Parameters<NativeServices['portfolios']['deleteClientLink']>[3],
      );
    case 'member_create':
      return services.portfolios.createMember(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['createMember']>[2],
      );
    case 'members_decide':
      return services.portfolios.decideMembers(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['portfolios']['decideMembers']>[2],
      );
    case 'member_resolve':
      return services.portfolios.resolveMember(
        ctx,
        portfolioId,
        p.memberId as string,
        dto as Parameters<NativeServices['portfolios']['resolveMember']>[3],
      );
    case 'rule_preview':
      return services.rules.preview(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['rules']['preview']>[2],
      );
    case 'rule_publish':
      return services.rules.publish(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['rules']['publish']>[2],
      );
    case 'review_assign':
      return services.reviews.assignReview(
        ctx,
        portfolioId,
        p.reviewId as string,
        dto as Parameters<NativeServices['reviews']['assignReview']>[3],
      );
    case 'review_decide':
      return services.reviews.decideReview(
        ctx,
        portfolioId,
        p.reviewId as string,
        dto as Parameters<NativeServices['reviews']['decideReview']>[3],
      );
    case 'reviews_bulk_decide':
      return services.reviews.bulkDecideReviews(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['reviews']['bulkDecideReviews']>[2],
      );
    case 'annual_review_get':
      return services.reviews.getAnnualReview(ctx, portfolioId);
    case 'annual_review_refresh':
      return services.reviews.refreshAnnualReview(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['reviews']['refreshAnnualReview']>[2],
      );
    case 'annual_review_reopen':
      return services.reviews.reopenAnnualReview(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['reviews']['reopenAnnualReview']>[2],
      );
    case 'import_create':
      return services.imports!.createJob(
        ctx,
        portfolioId,
        dto as Parameters<NonNullable<NativeServices['imports']>['createJob']>[2],
      );
    case 'import_action':
      return services.imports!.action(
        ctx,
        portfolioId,
        p.jobId as string,
        p.importAction as string,
        dto as Parameters<NonNullable<NativeServices['imports']>['action']>[4],
      );
    case 'subscriptions_list':
      return services.changes.listSubscriptions(ctx, portfolioId);
    case 'deliveries_list':
      return services.changes.listDeliveries(ctx, portfolioId);
    case 'subscription_update':
      return services.changes.updateSubscription(
        ctx,
        portfolioId,
        p.subscriptionId as string,
        dto as Parameters<NativeServices['changes']['updateSubscription']>[3],
      );
    case 'bookmark_update':
      return services.phase11.updateBookmark(
        ctx,
        portfolioId,
        p.bookmarkId as string,
        dto as Parameters<NativeServices['phase11']['updateBookmark']>[3],
      );
    case 'bookmark_delete':
      return services.phase11.deleteBookmark(ctx, portfolioId, p.bookmarkId as string);
    case 'fit_refresh':
      return services.phase11.refreshFit(ctx, portfolioId);
    case 'watch_conversion_preview':
      return services.phase11.previewWatchConversion(ctx, portfolioId);
    case 'watch_conversion_apply':
      return services.phase11.applyWatchConversion(
        ctx,
        portfolioId,
        dto as Parameters<NativeServices['phase11']['applyWatchConversion']>[2],
      );
    case 'output_get':
      return services.outputs.get(ctx, portfolioId, p.jobId as string);
    case 'output_cancel':
      return services.outputs.cancel(ctx, portfolioId, p.jobId as string);
    case 'output_retry':
      return services.outputs.retry(ctx, portfolioId, p.jobId as string);
    case 'output_reconcile':
      return services.outputs.reconcile(ctx, portfolioId, p.jobId as string);
    case 'snapshots_list':
      return services.analytics.listSnapshots(ctx, portfolioId);
    case 'snapshot_get':
      return services.analytics.snapshot(ctx, portfolioId, p.snapshotId as string);
    case 'taxonomy_get':
      return services.rules.taxonomy(ctx, p.version as number | undefined);
    case 'templates_list':
      return services.rules.listTemplates(ctx);
    case 'template_version_get':
      return services.rules.templateVersion(ctx, p.templateId as string, p.versionId as string);
    case 'operation_reconcile':
      return services.phase11.reconcileOperation(
        ctx,
        portfolioId,
        p.operationId as string,
        dto as Parameters<NativeServices['phase11']['reconcileOperation']>[3],
      );
    default:
      throw new BadRequestException('Unsupported Research Portfolio management action');
  }
}

function assertBoundedNativeJSON(value: unknown, depth = 0): void {
  if (depth > 24) throw new BadRequestException('Management input nesting is too deep');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    for (const item of value) assertBoundedNativeJSON(item, depth + 1);
    return;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new BadRequestException('Input must contain native JSON values only');
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        '__proto__',
        'prototype',
        'constructor',
        'tenantId',
        'userId',
        'portfolioId',
        'researchPortfolioId',
        'scopeVersion',
      ].includes(key)
    )
      throw new BadRequestException(key + ' is controlled by the server');
    assertBoundedNativeJSON(item, depth + 1);
  }
}
export function parseResearchPortfolioManagementInput(raw: unknown): Record<string, unknown> {
  assertBoundedNativeJSON(raw);
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > 16000000)
    throw new BadRequestException('Management input exceeds the bounded request size');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Management input must be an object');
  const input = raw as Record<string, unknown>,
    action = input.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(actions, action))
    throw new BadRequestException('Unsupported Research Portfolio management action');
  const spec = actions[action as keyof typeof actions];
  validate(
    {
      type: 'object',
      properties: {
        conversationId: { type: 'string', format: 'uuid' },
        action: { type: 'string', enum: [action] },
        confirmed: { type: 'boolean', enum: [true] },
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: spec.properties,
          required: spec.required,
        },
      },
      required: ['conversationId', 'action', 'parameters', ...(spec.readOnly ? [] : ['confirmed'])],
      additionalProperties: false,
    },
    input,
    'input',
  );
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}
export function validateResearchPortfolioInstitutionalInput(
  input: Record<string, unknown>,
  kind: 'brief' | 'meeting',
): {
  conversationId: string;
  operationKey: string;
  confirmed: true;
  meetingId?: string;
  selectedReviewIds?: string[];
} {
  assertBoundedNativeJSON(input);
  const properties: Record<string, Schema> = {
    conversationId: { type: 'string', format: 'uuid' },
    operationKey: { type: 'string', minLength: 1, maxLength: 128 },
    confirmed: { type: 'boolean', enum: [true] },
    ...(kind === 'meeting'
      ? {
          meetingId: { type: 'string', format: 'uuid' },
          selectedReviewIds: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', format: 'uuid' },
          },
        }
      : {}),
  };
  validate(
    {
      type: 'object',
      properties,
      required: ['conversationId', 'operationKey', 'confirmed'],
      additionalProperties: false,
    },
    input,
    'input',
  );
  const selection = input.selectedReviewIds as string[] | undefined;
  if (selection && new Set(selection).size !== selection.length)
    throw new BadRequestException('Selected reviews must be unique');
  return input as {
    conversationId: string;
    operationKey: string;
    confirmed: true;
    meetingId?: string;
    selectedReviewIds?: string[];
  };
}
