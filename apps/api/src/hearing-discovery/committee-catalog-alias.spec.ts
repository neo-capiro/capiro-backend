import { committeeCatalogCode, committeeCatalogReadCodes } from './committee-catalog-alias.js';
import {
  publishedCommitteeIdentity,
  storedCommitteeIdentity,
} from './hearing-committee-identity.js';

describe('verified China Select catalog alias', () => {
  it('resolves the independently verified January6 publisher code in both directions without rewriting ingestion', () => {
    expect(publishedCommitteeIdentity([{ systemCode: 'hlqj00' }]).committeeSystemCode).toBe(
      'hlqj00',
    );
    expect(storedCommitteeIdentity({ committeeSystemCode: 'hlqj00' }).committeeSystemCode).toBe(
      'hsqj00',
    );
    expect(committeeCatalogReadCodes('hsqj00')).toEqual(['hsqj00', 'hlqj00']);
    expect(committeeCatalogReadCodes('HLQJ00')).toEqual(['hsqj00', 'hlqj00']);
    expect(committeeCatalogCode('hlqj01')).toBe('hlqj01');
  });
  it('retains the publisher code on ingestion and maps it only on reads', () => {
    expect(publishedCommitteeIdentity([{ systemCode: 'hlzs00' }]).committeeSystemCode).toBe(
      'hlzs00',
    );
    expect(storedCommitteeIdentity({ committeeSystemCode: 'hlzs00' })).toEqual({
      committeeSystemCode: 'hszs00',
      subcommitteeSystemCode: null,
    });
    expect(storedCommitteeIdentity({ committeeCode: 'HLZS00' }).committeeSystemCode).toBe('hszs00');
    expect(committeeCatalogReadCodes('hszs00')).toEqual(['hszs00', 'hlzs00']);
    expect(committeeCatalogReadCodes('HLZS00')).toEqual(['hszs00', 'hlzs00']);
  });
  it.each(['hlig00', 'hlzs01', 'hszs01', 'sszs00', 'China Select'])(
    'does not infer another alias for %s',
    (code) => {
      expect(committeeCatalogCode(code)).toBe(code.toLowerCase());
      expect(committeeCatalogReadCodes(code)).toEqual([code.toLowerCase()]);
    },
  );
});
