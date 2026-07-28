from pathlib import Path

path = Path('scripts/apply-legiwatch-session-history-patches.py')
text = path.read_text(encoding='utf-8')
block = '''replace_once(
    api_file,
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
    """    onSuccess: () => qc.invalidateQueries({ queryKey: ['intel', 'hearings'] }),""",
)

'''
if text.count(block) != 1:
    raise RuntimeError(f'expected one no-op block, found {text.count(block)}')
path.write_text(text.replace(block, '', 1), encoding='utf-8')
print('Repaired session patch runner')
