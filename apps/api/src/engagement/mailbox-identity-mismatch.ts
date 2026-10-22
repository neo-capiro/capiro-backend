/** A known collision, distinct from a transient or unclassified persistence failure. */
export class MailboxIdentityMismatchError extends Error {
  constructor() {
    super('Mail mailbox identity mismatch');
    this.name = 'MailboxIdentityMismatchError';
  }
}
