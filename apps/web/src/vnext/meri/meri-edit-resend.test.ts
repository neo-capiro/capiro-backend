import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const meriDir = resolve(process.cwd(), 'src/vnext/meri');

function readMeri(name: string): string {
  return readFileSync(resolve(meriDir, name), 'utf8');
}

describe('vNext edit-and-resend — genuinely truncates and replaces, and says so', () => {
  test('EDIT is only offered on the still-standing last user turn, and only while idle', () => {
    const source = readMeri('VNextMeriMessage.tsx');
    expect(source).toContain('message.id === controller.lastUserMessageId && !isStreaming');
  });

  test('routes through the real controller edit-resend flow, not a local append', () => {
    const source = readMeri('VNextMeriMessage.tsx');
    expect(source).toContain('controller.setEditingMessageId(message.id)');
    expect(source).toContain('controller.setEditingText(message.content)');
    expect(source).toContain('controller.handleEditResend()');
  });

  test('the resend notice is honest about replacing, not appending, the answer below', () => {
    const source = readMeri('VNextMeriMessage.tsx');
    expect(source).toContain('RESENDING REPLACES THE ANSWER BELOW');
  });
});
