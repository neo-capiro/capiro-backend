import { gmailFolderFromLabelIds } from './google-sync.service.js';

/**
 * The widened Gmail sync derives folder + sent-ness from each message's own
 * labelIds (one query now covers the whole mailbox, so there is no per-stream
 * label anymore). SENT wins over INBOX (a self-addressed mail is the sender's
 * copy), no system mailbox label means archived, and absent labelIds degrade
 * to archive rather than crashing.
 */
describe('gmailFolderFromLabelIds', () => {
  it('marks SENT messages sent even when they also sit in the inbox', () => {
    expect(gmailFolderFromLabelIds(['SENT', 'INBOX'])).toEqual({ folder: 'sent', isSent: true });
    expect(gmailFolderFromLabelIds(['SENT'])).toEqual({ folder: 'sent', isSent: true });
  });

  it('maps INBOX to inbox', () => {
    expect(gmailFolderFromLabelIds(['INBOX', 'IMPORTANT'])).toEqual({
      folder: 'inbox',
      isSent: false,
    });
  });

  it('treats mail without a system mailbox label as archived (custom labels included)', () => {
    expect(gmailFolderFromLabelIds(['Label_123', 'IMPORTANT'])).toEqual({
      folder: 'archive',
      isSent: false,
    });
    expect(gmailFolderFromLabelIds([])).toEqual({ folder: 'archive', isSent: false });
    expect(gmailFolderFromLabelIds(undefined)).toEqual({ folder: 'archive', isSent: false });
  });
});
