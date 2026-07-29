from pathlib import Path

path = Path('apps/web/src/pages/clients/tracker/TrackerFeedPanel.test.tsx')
text = path.read_text(encoding='utf-8')
old = """    expect(feedUrls.some((url) => url.includes('source=all') && url.includes('workState=all'))).toBe(true);"""
new = """    expect(
      feedUrls.some(
        (url) => url.includes('workState=all') && !url.includes('sourceType='),
      ),
    ).toBe(true);"""
if text.count(old) != 1:
    raise RuntimeError(f'expected one stale all-source assertion, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Corrected all-source feed URL assertion')
