import { MeriActionProposalController } from './meri-action-proposal.controller.js';

describe('one-time action approval response', () => {
  it('prevents caching and referrer propagation of the successful publish address', () => {
    expect(Reflect.getMetadata('__headers__', MeriActionProposalController.prototype.approve)).toEqual(
      expect.arrayContaining([
        { name: 'Cache-Control', value: 'no-store' },
        { name: 'Referrer-Policy', value: 'no-referrer' },
      ]),
    );
  });
});
