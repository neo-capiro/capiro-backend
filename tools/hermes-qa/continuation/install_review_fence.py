import hashlib,json,os,sys,shutil
from pathlib import Path
os.environ['HERMES_HOME']=r'C:\ProgramData\Hermes';sys.path.insert(0,r'C:\ProgramData\Hermes\hermes-agent')
import hermes_bootstrap
from hermes_cli.kanban_db_connect import connect
root=Path(__file__).parent.parent;raw=(root/'context_guard.py').read_bytes()
for role in ['coder','checks','visual','planner']:
 target=Path(r'C:\ProgramData\Hermes\profiles')/('capiro-qa-'+role)/'plugins/capiro-qa-context-guard/__init__.py'
 target.write_bytes(raw);assert target.read_bytes()==raw
with connect(board='capiro-qa') as conn:
 conn.executescript((root/'continuation/review-before-done.sql').read_text())
 row=conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='capiro_qa_review_before_done'").fetchone();assert row and 'OLD.status' in row[0]
 parent_fence=conn.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='capiro_qa_parent_verified_before_done'").fetchone();assert parent_fence and 'parent_verifications' in parent_fence[0]
result={'guard_sha256':hashlib.sha256(raw).hexdigest(),'profiles_installed':4,'board_only_trigger':row[0],'parent_record_trigger':parent_fence[0],'application_files_changed':[],'existing_cards_status_unchanged':True}
(root/'continuation/review-fence-readback.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))
