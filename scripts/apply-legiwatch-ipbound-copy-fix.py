from pathlib import Path

path = Path('apps/web/src/pages/intelligence/HearingWatchPage.tsx')
text = path.read_text(encoding='utf-8')
old_comment = '''            // An IP-bound / short-lived source (YouTube-live) is NOT persisted and
            // resolves at connect time; surface it as a warning, not a success.'''
new_comment = '''            // An IP-bound / short-lived source (YouTube-live) is not persisted.
            // Surface the real browser-tab fallback as a warning, not a success.'''
old_copy = '''                    <Text type="secondary">
                      This stream URL is IP-bound and expires (~6h). It is NOT saved with
                      the session; it resolves at connect time. That path isn&apos;t wired
                      yet — this source is a known limitation while YouTube-live is gated
                      off.
                    </Text>'''
new_copy = '''                    <Text type="secondary">
                      This media URL is short-lived and is not saved with the session. Open
                      the original source from the Live Hearing Room, play it, and share that
                      browser tab&apos;s audio to transcribe it.
                    </Text>'''
for old, new in [(old_comment, new_comment), (old_copy, new_copy)]:
    if text.count(old) != 1:
        raise RuntimeError(f'expected one anchor, found {text.count(old)}: {old[:100]!r}')
    text = text.replace(old, new, 1)
path.write_text(text, encoding='utf-8')
print('Applied truthful IP-bound browser-capture copy')
