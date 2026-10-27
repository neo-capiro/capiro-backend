import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { retainedReadObject } from './retained-read-context.js';

// The existing Meri Florida receiver supplies these normalized finite selectors.
// Intel remains the owner of membership, folder, wall and source permissions.
const request = z
  .object({
    q: z.string().max(200),
    fiscalYear: z.string().regex(/^20\d{2}-\d{2}$/),
    projectId: z.string().max(250),
    offset: z.number().int().min(0).max(10000),
    sessionKey: z.string().max(60),
    folderId: z.string().min(1).max(100).nullable(),
    clientId: z
      .string()
      .uuid()
      .transform((value) => value.toLowerCase())
      .nullable(),
  })
  .strict();
export type FloridaBudgetReadRequest = z.infer<typeof request>;
export function parseFloridaBudgetRead(value: unknown): FloridaBudgetReadRequest {
  const parsed = request.safeParse(value);
  if (!parsed.success) throw new BadRequestException('Invalid Florida budget selection');
  return parsed.data;
}

export function receiveFloridaBudgetRead(input: FloridaBudgetReadRequest, value: unknown) {
  try {
    const result = retainedReadObject(value, [
      'scope',
      'fiscalYear',
      'projects',
      'nextOffset',
      'documents',
      'amounts',
      'events',
      'notice',
    ]);
    const scope = retainedReadObject(result.scope, [
      'jurisdiction',
      'sessionKey',
      'folderId',
      'clientId',
    ]);
    if (
      scope.jurisdiction !== 'FL' ||
      scope.sessionKey !== input.sessionKey ||
      scope.folderId !== input.folderId ||
      (scope.clientId !== null &&
        (typeof scope.clientId !== 'string' ||
          !z.string().uuid().safeParse(scope.clientId).success)) ||
      (input.clientId !== null && scope.clientId !== input.clientId) ||
      (input.clientId === null && input.folderId === null && scope.clientId !== null) ||
      result.fiscalYear !== input.fiscalYear ||
      result.notice !==
        'Selected publisher evidence. Requests and chamber alternatives are not awards. No statewide aggregate is inferred.'
    )
      throw Error();
    for (const [name, max] of [
      ['projects', 100],
      ['documents', 101],
      ['amounts', 501],
      ['events', 101],
    ] as const)
      if (!Array.isArray(result[name]) || result[name].length > max) throw Error();
    if (
      result.nextOffset !== null &&
      (result.nextOffset !== input.offset + 100 || (result.projects as unknown[]).length !== 100)
    )
      throw Error();
    // Do not reinterpret the stored observation JSON or calculate amounts. The
    // existing typed Meri projection admits declared row fields and preserves
    // observation IDs/sourceRevision, exact units, stage, FY and source identity.
    return {
      tool: 'get_florida_budget_project' as const,
      generatedAt: new Date().toISOString(),
      result,
      authority:
        'Source quotations retain their document identity. Meri relevance is an inference for review; keyword grammar and current folder decisions control assignments.',
    };
  } catch {
    throw new ServiceUnavailableException('Florida budget source result unavailable');
  }
}
