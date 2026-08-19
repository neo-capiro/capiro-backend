import { Session5RefusalError } from './session5.mjs';

function decimal(value) {
  if (!Number.isFinite(Number(value))) {
    throw new Error(`Expected finite number, got ${value}`);
  }
  return String(Number(value));
}

function fromNumberAttribute(value, fallback = 0) {
  return value?.N === undefined ? fallback : Number(value.N);
}

export class AwsCliDynamoReservationLedger {
  constructor(runner, config) {
    this.runner = runner;
    this.tableName = config.ledgerTableName;
    this.controlKey = 'CONTROL#SESSION5';
  }

  async reserve(input) {
    const reservationKey = `RESERVATION#${input.reservationId}`;
    const remaining =
      Number(input.effectiveCapUsd) - Number(input.reservedCostUsd);
    if (
      remaining < 0 ||
      Number(input.effectiveCapUsd) > Number(input.hardCapUsd)
    ) {
      throw new Session5RefusalError(
        'BUDGET_LIMIT',
        'Reservation exceeds authorized spend cap',
      );
    }
    const transaction = {
      TransactItems: [
        {
          Put: {
            TableName: this.tableName,
            Item: {
              pk: { S: reservationKey },
              kind: { S: 'reservation' },
              reservationId: { S: input.reservationId },
              jobId: { S: input.jobId },
              attempt: { N: String(input.attempt) },
              status: { S: 'ACTIVE' },
              reservedCostUsd: { N: decimal(input.reservedCostUsd) },
              createdAt: { S: input.at },
              updatedAt: { S: input.at },
            },
            ConditionExpression: 'attribute_not_exists(pk)',
          },
        },
        {
          Update: {
            TableName: this.tableName,
            Key: { pk: { S: this.controlKey } },
            UpdateExpression:
              'SET activeJobs = if_not_exists(activeJobs, :zero) + :one, ' +
              'spentAndReservedUsd = if_not_exists(spentAndReservedUsd, :zero) + :cost, ' +
              'updatedAt = :at',
            ConditionExpression:
              '(attribute_not_exists(activeJobs) OR activeJobs < :max) AND ' +
              '(attribute_not_exists(spentAndReservedUsd) OR spentAndReservedUsd <= :remaining)',
            ExpressionAttributeValues: {
              ':zero': { N: '0' },
              ':one': { N: '1' },
              ':cost': { N: decimal(input.reservedCostUsd) },
              ':max': { N: String(input.maxConcurrent) },
              ':remaining': { N: decimal(remaining) },
              ':at': { S: input.at },
            },
          },
        },
      ],
    };
    try {
      await this.runner.invoke('dynamodb', 'transact-write-items', transaction);
    } catch (error) {
      const existing = await this.#get(reservationKey);
      if (
        existing &&
        existing.status?.S === 'ACTIVE' &&
        existing.jobId?.S === input.jobId &&
        Number(existing.reservedCostUsd?.N) === Number(input.reservedCostUsd)
      ) {
        return { idempotent: true, reservationId: input.reservationId };
      }
      throw new Session5RefusalError(
        'RESERVATION_REFUSED',
        'Atomic Session 5 spend/concurrency reservation was refused',
        { cause: String(error?.message ?? error) },
      );
    }
    return { idempotent: false, reservationId: input.reservationId };
  }

  async settle(input) {
    const reservationKey = `RESERVATION#${input.reservationId}`;
    const existing = await this.#get(reservationKey);
    if (!existing) {
      throw new Session5RefusalError(
        'RESERVATION_NOT_FOUND',
        input.reservationId,
      );
    }
    if (existing.status?.S === 'SETTLED') return { idempotent: true };
    if (existing.status?.S !== 'ACTIVE') {
      throw new Session5RefusalError(
        'RESERVATION_STATE_REFUSAL',
        `Cannot settle ${existing.status?.S}`,
      );
    }
    const reserved = Number(existing.reservedCostUsd?.N ?? 0);
    const actual = Number(input.reconciledCostUsd);
    if (!Number.isFinite(actual) || actual < 0) {
      throw new Session5RefusalError(
        'INVALID_RECONCILED_COST',
        'Reconciled provider cost is invalid',
      );
    }
    const delta = actual - reserved;
    try {
      await this.runner.invoke('dynamodb', 'transact-write-items', {
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: { S: reservationKey } },
              UpdateExpression:
                'SET #status = :settled, reconciledCostUsd = :actual, settledAt = :at, updatedAt = :at',
              ConditionExpression: '#status = :active',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':settled': { S: 'SETTLED' },
                ':active': { S: 'ACTIVE' },
                ':actual': { N: decimal(actual) },
                ':at': { S: input.at },
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: { S: this.controlKey } },
              UpdateExpression:
                'SET activeJobs = activeJobs - :one, ' +
                'spentAndReservedUsd = spentAndReservedUsd + :delta, ' +
                'settledSpendUsd = if_not_exists(settledSpendUsd, :zero) + :actual, ' +
                'updatedAt = :at',
              ConditionExpression: 'activeJobs >= :one',
              ExpressionAttributeValues: {
                ':one': { N: '1' },
                ':zero': { N: '0' },
                ':delta': { N: decimal(delta) },
                ':actual': { N: decimal(actual) },
                ':at': { S: input.at },
              },
            },
          },
        ],
      });
    } catch (error) {
      const after = await this.#get(reservationKey);
      if (after?.status?.S === 'SETTLED') return { idempotent: true };
      throw error;
    }
    return { idempotent: false, reconciledCostUsd: actual };
  }

  async release(input) {
    const reservationKey = `RESERVATION#${input.reservationId}`;
    const existing = await this.#get(reservationKey);
    if (!existing || existing.status?.S === 'RELEASED') {
      return { idempotent: true };
    }
    if (existing.status?.S !== 'ACTIVE') {
      throw new Session5RefusalError(
        'RESERVATION_STATE_REFUSAL',
        `Cannot release ${existing.status?.S}`,
      );
    }
    const reserved = Number(existing.reservedCostUsd?.N ?? 0);
    try {
      await this.runner.invoke('dynamodb', 'transact-write-items', {
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: { S: reservationKey } },
              UpdateExpression:
                'SET #status = :released, releaseReason = :reason, releasedAt = :at, updatedAt = :at',
              ConditionExpression: '#status = :active',
              ExpressionAttributeNames: { '#status': 'status' },
              ExpressionAttributeValues: {
                ':released': { S: 'RELEASED' },
                ':active': { S: 'ACTIVE' },
                ':reason': { S: input.reason },
                ':at': { S: input.at },
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { pk: { S: this.controlKey } },
              UpdateExpression:
                'SET activeJobs = activeJobs - :one, spentAndReservedUsd = spentAndReservedUsd - :cost, updatedAt = :at',
              ConditionExpression:
                'activeJobs >= :one AND spentAndReservedUsd >= :cost',
              ExpressionAttributeValues: {
                ':one': { N: '1' },
                ':cost': { N: decimal(reserved) },
                ':at': { S: input.at },
              },
            },
          },
        ],
      });
    } catch (error) {
      const after = await this.#get(reservationKey);
      if (after?.status?.S === 'RELEASED') return { idempotent: true };
      throw error;
    }
    return { idempotent: false };
  }

  async snapshot() {
    const item = await this.#get(this.controlKey);
    return Object.freeze({
      activeJobs: fromNumberAttribute(item?.activeJobs, 0),
      spentAndReservedUsd: fromNumberAttribute(
        item?.spentAndReservedUsd,
        0,
      ),
      settledSpendUsd: fromNumberAttribute(item?.settledSpendUsd, 0),
    });
  }

  async #get(pk) {
    const response = await this.runner.invoke('dynamodb', 'get-item', {
      TableName: this.tableName,
      Key: { pk: { S: pk } },
      ConsistentRead: true,
    });
    return response.Item ?? null;
  }
}
