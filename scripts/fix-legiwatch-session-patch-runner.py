from pathlib import Path

# Remove the session runner's accidental no-op replacement. The target line
# legitimately appears in two hooks, so the one-anchor safety guard rejected it.
session_path = Path('scripts/apply-legiwatch-session-history-patches.py')
session_text = session_path.read_text(encoding='utf-8')
session_block = '''replace_once(
    api_file,
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
)

'''
if session_text.count(session_block) != 1:
    raise RuntimeError(f'expected one no-op block, found {session_text.count(session_block)}')
session_path.write_text(session_text.replace(session_block, '', 1), encoding='utf-8')

# Re-anchor the first-run copy assertion to the actual test. The prior runner
# assumed a second assertion that the real test never contained.
feed_path = Path('scripts/apply-legiwatch-feed-deeplink-patches.py')
feed_text = feed_path.read_text(encoding='utf-8')
stale = '''replace_once(
    radar_test,
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();""",
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();
    expect(screen.getByText(/legislation, hearings, regulations, and defense-budget changes/i)).toBeInTheDocument();""",
)
'''
repaired = '''replace_once(
    radar_test,
    """    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    // The permanent reopen control is present in the top bar.""",
    """    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    expect(screen.getByText(/legislation, hearings, regulations, and defense-budget changes/i)).toBeInTheDocument();
    // The permanent reopen control is present in the top bar.""",
)
'''
if feed_text.count(stale) != 1:
    raise RuntimeError(f'expected one stale feed test block, found {feed_text.count(stale)}')
feed_path.write_text(feed_text.replace(stale, repaired, 1), encoding='utf-8')

print('Repaired session and feed patch runners')
