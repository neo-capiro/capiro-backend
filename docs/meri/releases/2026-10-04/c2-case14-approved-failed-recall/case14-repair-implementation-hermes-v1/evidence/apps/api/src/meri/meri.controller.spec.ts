import { HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { MeriController } from './meri.controller.js';

describe('MeriController tool success status', () => {
  it('returns HTTP 200 for successful tool invocations without changing the POST route', () => {
    const descriptor = Object.getOwnPropertyDescriptor(MeriController.prototype, 'executeTool');
    expect(Reflect.getMetadata(PATH_METADATA, descriptor!.value)).toBe('tools/:name');
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, descriptor!.value)).toBe(200);
  });
});
