import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createMcpClient } from './meri-mcp-transport.js';

jest.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: jest.fn() }));
jest.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: jest.fn(),
}));

function make() {
  const sdk = {
    connect: jest.fn(async () => undefined),
    close: jest.fn(async () => undefined),
    listTools: jest.fn(),
  };
  jest.mocked(Client).mockImplementation(() => sdk as unknown as Client);
  return {
    sdk,
    client: createMcpClient(
      { transport: 'http', endpoint: 'https://provider.example/mcp' },
      undefined,
    ),
  };
}

describe('authenticated MCP tool pagination', () => {
  afterEach(() => jest.clearAllMocks());
  test('follows all pages before read-only filtering and closes the transport', async () => {
    const { sdk, client } = make();
    sdk.listTools
      .mockResolvedValueOnce({ tools: [{ name: 'write_tool' }], nextCursor: 'page-2' })
      .mockResolvedValueOnce({ tools: [{ name: 'list_bases' }] });
    expect((await client.listTools()).map((t) => t.name)).toEqual(['write_tool', 'list_bases']);
    expect(sdk.listTools).toHaveBeenNthCalledWith(2, { cursor: 'page-2' });
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
  test('repeated cursors fail discovery rather than silently using an incomplete tool list', async () => {
    const { sdk, client } = make();
    sdk.listTools.mockResolvedValue({ tools: [], nextCursor: 'same-page' });
    await expect(client.listTools()).rejects.toThrow('repeated a page');
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
  test('provider failure fails the operation and closes the connection', async () => {
    const { sdk, client } = make();
    sdk.listTools.mockRejectedValue(new Error('authorization expired'));
    await expect(client.listTools()).rejects.toThrow('authorization expired');
    expect(sdk.close).toHaveBeenCalledTimes(1);
  });
});
