import { verifyWsOrigin } from './ws-origin.js';

describe('vNext hearing WebSocket origin', () => {
  const check = (origin: string) => verifyWsOrigin({
    origin,
    req: { headers: { origin } } as Parameters<typeof verifyWsOrigin>[0]['req'],
  });

  it('accepts the vNext production origin', () => {
    expect(check('https://os.capiro.ai')).toBe(true);
  });

  it.each(['https://os.capiro.ai.evil.example', 'http://os.capiro.ai'])('rejects %s', (origin) => {
    expect(check(origin)).toBe(false);
  });
});
