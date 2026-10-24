import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { routeInventory, parityProblems } from './verify-outreach-v3-p1-route-parity.mjs';

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

const readSource = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');

test('the actual four mounted controllers preserve all fourteen mailbox method/path pairs', () => {
  assert.deepEqual(parityProblems(), []);
});

test('missing or method-changed callbacks are detected independently for both providers', () => {
  for (const provider of ['google', 'microsoft']) {
    for (const replacement of ["", "@Post('callback')"]) {
      const problems = parityProblems(file => {
        const source = readSource(file);
        return file.endsWith(`${provider}-callbacks.controller.ts`)
          ? source.replace("@Get('callback')", replacement) : source;
      });
      assert.equal(problems.length, 1);
      assert.match(problems[0], new RegExp(`^${provider} route inventory changed`));
    }
  }
});

test('duplicate registrations and changed provider prefixes refuse', () => {
  assert.throws(() => parityProblems(file => {
    const source = readSource(file);
    return file.endsWith('google-callbacks.controller.ts') ? source + "\n@Get('callback') duplicate() {}" : source;
  }), /duplicate registered routes/);
  const problems = parityProblems(file => readSource(file).replace("@Controller('engagement/integrations/microsoft')", "@Controller('other')"));
  assert.equal(problems.length, 1);
});
