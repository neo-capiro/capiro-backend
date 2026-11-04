import { ClientAssociationService } from './client-association.service.js';

const client = (id: string, primaryContactEmail: string | null = null) => ({
  id, name: `Synthetic ${id}`, website: null, primaryContactEmail, intakeData: null,
});

function fixture(clients = [client('A'), client('B')], contacts: Array<{ clientId: string; email: string }> = []) {
  const tx = {
    client: { findMany: jest.fn().mockResolvedValue(clients) },
    clientPerson: { findMany: jest.fn().mockResolvedValue(contacts) },
    meeting: { findMany: jest.fn().mockResolvedValue([]) },
  };
  return { tx, run: (emails: string[], subject = '') => new ClientAssociationService().associate(tx as never, 'tenant-synthetic', { attendeeEmails: emails, subject }) };
}

describe('contact-based client association', () => {
  test.each([false, true])('a shared contact is ambiguous regardless of database order (reverse=%s)', async (reverse) => {
    const clients = [client('A', 'shared@example.invalid'), client('B', 'shared@example.invalid')];
    const contacts = clients.map(({ id }) => ({ clientId: id, email: 'shared@example.invalid' }));
    const f = fixture(reverse ? clients.reverse() : clients, reverse ? contacts.reverse() : contacts);
    const result = await f.run(['SHARED@example.invalid'], 'Synthetic A planning');
    expect(result).toMatchObject({ clientId: null, score: 0, signals: { ambiguousClientContacts: true } });
    expect(f.tx.meeting.findMany).not.toHaveBeenCalled();
    expect(f.tx.clientPerson.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: 'tenant-synthetic', email: { in: ['shared@example.invalid'], mode: 'insensitive' } } }));
  });

  test('a primary email duplicated in people rows does not outvote a distinct client attendee', async () => {
    const f = fixture([client('A', 'a@example.invalid'), client('B')], [
      { clientId: 'A', email: ' A@EXAMPLE.INVALID ' },
      { clientId: 'A', email: 'a@example.invalid' },
      { clientId: 'B', email: 'b@example.invalid' },
    ]);
    expect(await f.run(['a@example.invalid', 'b@example.invalid'])).toMatchObject({ clientId: null, signals: { ambiguousClientContacts: true } });
  });

  test('a unique leader still routes on distinct attendee emails and emits each contact once', async () => {
    const f = fixture([client('A', 'a@example.invalid'), client('B')], [
      { clientId: 'A', email: 'a@example.invalid' },
      { clientId: 'A', email: 'second@example.invalid' },
      { clientId: 'B', email: 'b@example.invalid' },
    ]);
    expect(await f.run(['a@example.invalid', 'second@example.invalid', 'b@example.invalid'])).toMatchObject({
      clientId: 'A', score: 0.95, signals: { knownContactsFound: ['a@example.invalid', 'second@example.invalid'] },
    });
  });

  test('contacts for an inactive client do not block an active unique match', async () => {
    const f = fixture([client('A')], [{ clientId: 'inactive', email: 'shared@example.invalid' }, { clientId: 'A', email: 'shared@example.invalid' }]);
    expect(await f.run(['shared@example.invalid'])).toMatchObject({ clientId: 'A', score: 0.95 });
  });

  test('no known contact retains ordinary matching and an empty tenant stays unassigned', async () => {
    const f = fixture([client('A')]);
    expect(await f.run([], 'Synthetic A planning')).toMatchObject({ clientId: 'A' });
    expect(f.tx.meeting.findMany).not.toHaveBeenCalled();
    expect(await fixture([]).run(['unknown@example.invalid'])).toMatchObject({ clientId: null, score: 0 });
  });
});
