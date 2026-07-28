from pathlib import Path

path = Path('scripts/apply-legiwatch-feed-deeplink-patches.py')
text = path.read_text(encoding='utf-8')
old = '''replace_once(
    radar_test,
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();""",
    """    expect(screen.getByText('What LegiWatch does')).toBeInTheDocument();
    expect(screen.getByText('You set a watchlist for each client')).toBeInTheDocument();
    expect(screen.getByText(/legislation, hearings, regulations, and defense-budget changes/i)).toBeInTheDocument();""",
)
'''
new = '''replace_once(
    radar_test,
    """    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    // The permanent reopen control is present in the top bar.""",
    """    await waitFor(() => expect(screen.getByText('What LegiWatch does')).toBeInTheDocument());
    expect(screen.getByText(/legislation, hearings, regulations, and defense-budget changes/i)).toBeInTheDocument();
    // The permanent reopen control is present in the top bar.""",
)
'''
if text.count(old) != 1:
    raise RuntimeError(f'expected one stale Radar test patch, found {text.count(old)}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Repaired feed patch runner')
