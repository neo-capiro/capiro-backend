import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MERI_ROOT = __dirname;
const WEB_ROOT = join(__dirname, '../../../web/src');

function readApi(name: string): string {
  return readFileSync(join(MERI_ROOT, name), 'utf8');
}

function readWeb(rel: string): string {
  return readFileSync(join(WEB_ROOT, rel), 'utf8');
}

describe('Meri stream/launcher fail-closed contracts', () => {
  test('the stream controller classifies pre-stream failures instead of letting Nest emit a generic 500', () => {
    const text = readApi('meri.controller.ts');
    expect(text).toContain('runMeriStreamWithSetupGuard');
    expect(text).toContain('this.logger.error');
    expect(text).not.toMatch(
      /res\.setHeader\('Content-Type', 'text\/event-stream'\);\s*[\s\S]*await this\.service\.streamMessage/,
    );
  });

  test('vNext Ctrl/Cmd+J uses the canonical /meri launcher, not the legacy popup flag', () => {
    const text = readWeb('vnext/shell/AppShellUui/index.tsx');
    expect(text).toContain('openVNextMeriWorkspaceWindow');
    expect(text).not.toContain('openMeriWorkspaceWindow');
  });

  test('the chat controller formats HTTP stream failures instead of dumping the raw body', () => {
    const text = readWeb('components/chat/useMeriChatController.ts');
    expect(text).toContain('formatMeriHttpError');
    expect(text).not.toContain('Error ${res.status}: ${text || res.statusText}');
  });

  test('provider resolution failures are classified before they can become a generic 500', () => {
    expect(readApi('meri.service.ts')).toContain('meriProviderConfigurationError');
    expect(readApi('meriv3-proxy.service.ts')).toContain('meriProviderConfigurationError');
  });
});
