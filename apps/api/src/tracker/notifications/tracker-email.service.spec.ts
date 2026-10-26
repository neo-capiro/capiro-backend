import { ConfigService } from '@nestjs/config';
import { SESv2Client, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import { TrackerEmailService } from './tracker-email.service.js';

const mockSend = jest.fn();
const mockDestroy = jest.fn();
jest.mock('@aws-sdk/client-sesv2', () => ({
  ...jest.requireActual('@aws-sdk/client-sesv2'),
  SESv2Client: jest.fn().mockImplementation(() => ({ send: mockSend, destroy: mockDestroy })),
}));

describe('Tracker SES acceptance evidence', () => {
  let service: TrackerEmailService;
  beforeEach(() => {
    jest.clearAllMocks();
    service = new TrackerEmailService(
      new ConfigService({
        AWS_REGION_DEFAULT: 'us-east-1',
        TRACKER_ALERT_EMAIL_FROM: 'alerts@example.test',
      }),
    );
  });
  afterEach(() => service.onModuleDestroy());
  const send = () => service.send('recipient@example.test', 'Subject', '<p>Alert</p>', 'Alert');

  it('bounds SDK attempts and reports provider acceptance, never delivery', async () => {
    mockSend.mockResolvedValue({ MessageId: 'synthetic-receipt' });
    await expect(send()).resolves.toEqual({ status: 'accepted', messageId: 'synthetic-receipt' });
    expect(SESv2Client).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 1 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 429])(
    'records a parsed SES %i rejection as definite failure',
    async (httpStatusCode) => {
      mockSend.mockRejectedValue(
        new SESv2ServiceException({
          name: 'Rejected',
          $fault: 'client',
          $metadata: { httpStatusCode },
          message: 'private provider text',
        }),
      );
      await expect(send()).resolves.toEqual({
        status: 'failed',
        error: 'SES rejected the request',
      });
      expect(mockSend).toHaveBeenCalledTimes(1);
    },
  );

  it.each([408, 500, 503])('keeps SES %i acceptance unknown', async (httpStatusCode) => {
    mockSend.mockRejectedValue(
      new SESv2ServiceException({
        name: 'Unavailable',
        $fault: 'server',
        $metadata: { httpStatusCode },
      }),
    );
    expect((await send()).status).toBe('outcome_unknown');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it.each([new Error('timeout'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }])(
    'does not infer rejection from a transport or untyped exception',
    async (cause) => {
      mockSend.mockRejectedValue(cause);
      expect((await send()).status).toBe('outcome_unknown');
    },
  );

  it('does not invent acceptance when a success response has no message id', async () => {
    mockSend.mockResolvedValue({});
    expect((await send()).status).toBe('outcome_unknown');
    service.onModuleDestroy();
    expect(mockDestroy).toHaveBeenCalled();
  });
});
