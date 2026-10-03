import assert from 'node:assert/strict';
import { it } from 'node:test';
import { inspectCase17Caller } from '../case17-build-authority.mjs';

for (const principal of ['hermes-cli', 'capirocli']) {
  it(`accepts the explicitly configured ${principal} read operator in the exact account`, () => {
    const caller = { Account: '967807252336', Arn: `arn:aws:iam::967807252336:user/${principal}` };
    assert.deepEqual(inspectCase17Caller(caller), { account: caller.Account, arn: caller.Arn });
  });
}

it('rejects other principals, account mismatches and missing STS identity', () => {
  for (const caller of [
    undefined,
    {},
    { Account: '000000000000', Arn: 'arn:aws:iam::967807252336:user/capirocli' },
    { Account: '967807252336', Arn: 'arn:aws:iam::000000000000:user/capirocli' },
    { Account: '967807252336', Arn: 'arn:aws:iam::967807252336:user/other' },
    { Account: '967807252336', Arn: 'arn:aws:iam::967807252336:user/capirocli-extra' },
    { Account: '967807252336', Arn: 'arn:aws:iam::967807252336:root' },
    { Account: '967807252336', Arn: 'arn:aws:sts::967807252336:assumed-role/capirocli/session' },
  ]) assert.throws(() => inspectCase17Caller(caller), /CASE17_IMMUTABLE_BUILD_UNPROVED/);
});
