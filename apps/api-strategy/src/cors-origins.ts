/** First-party web surfaces may call the separately hosted Strategy API. */
export function buildStrategyAllowedOrigins(configuredOrigins?: string): Set<string> {
  return new Set(
    [
      ...(configuredOrigins?.split(',') ?? ['http://localhost:5173']),
      'https://app.capiro.ai',
      'https://os.capiro.ai',
      'https://capiro.ai',
      'https://www.capiro.ai',
    ]
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}
