import test from 'node:test';
import assert from 'node:assert/strict';
import { routeInventory } from './verify-outreach-v3-p1-route-parity.mjs';

test('extracts controller routes independent of method implementation', () => {
  const source = `
    @Controller('engagement/example')
    export class Example {
      @Get('capabilities') list() {}
      @Post() create() {}
      @Delete(':id') remove() {}
    }
  `;
  assert.deepEqual(routeInventory(source), [
    'DELETE /engagement/example/:id',
    'GET /engagement/example/capabilities',
    'POST /engagement/example',
  ]);
});

test('different route methods remain distinguishable', () => {
  const source = `
    @Controller('engagement/example')
    export class Example {
      @Get('callback') get() {}
      @Post('callback') post() {}
    }
  `;
  assert.deepEqual(routeInventory(source), [
    'GET /engagement/example/callback',
    'POST /engagement/example/callback',
  ]);
});
