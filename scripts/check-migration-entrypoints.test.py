"""Behavior tests using an inert node substitute; no database/application execution."""
import os,shutil,subprocess,tempfile,unittest
from pathlib import Path

REPO=Path(os.environ.get('MIGRATION_ENTRYPOINT_REPO',Path(__file__).resolve().parents[1]))
SERVICES={'api-strategy':True,'onboard-api':False,'workspace':True}
BASH=shutil.which('bash') or ('C:/Program Files/Git/bin/bash.exe' if os.name=='nt' else '/bin/bash')

class Tests(unittest.TestCase):
    def invoke(self,service,verb,exit_code=0):
        root=Path(os.environ.get('MIGRATION_ENTRYPOINT_TEST_ROOT',Path(tempfile.gettempdir())/'migration-entrypoint-tests'))
        root.mkdir(parents=True,exist_ok=True)
        fixture=Path(tempfile.mkdtemp(prefix='case-',dir=root));bin_dir=fixture/'bin';bin_dir.mkdir()
        trace=fixture/'node-calls.txt'
        node=bin_dir/'node'
        node.write_text('''#!/bin/sh
printf '%s\n' "$1" >> "$MOCK_TRACE"
case "$1" in
  node_modules/prisma/build/index.js) exit "$MOCK_MIGRATE_EXIT" ;;
  *) exit 0 ;;
esac
''',encoding='utf8',newline='\n')
        node.chmod(0o755)
        env={k:v for k,v in os.environ.items() if k.upper() in {'PATH','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','PATHEXT'}}
        env.update(MOCK_BIN=str(bin_dir).replace('\\','/'),MOCK_TRACE=str(trace).replace('\\','/'),
                   MOCK_MIGRATE_EXIT=str(exit_code),ENTRYPOINT=str(REPO/f'apps/{service}/scripts/entrypoint.sh').replace('\\','/'),VERB=verb,
                   DATABASE_URL='postgresql://fixture:fixture@127.0.0.1:1/fixture',TMPDIR=str(fixture).replace('\\','/'))
        prefix='PATH="$(cygpath -u "$MOCK_BIN"):$PATH"' if os.name=='nt' else 'PATH="$MOCK_BIN:$PATH"'
        command=prefix+'; export PATH; exec /bin/sh "$ENTRYPOINT" "$VERB"'
        result=subprocess.run([BASH,'-c',command],cwd=fixture,env=env,capture_output=True,text=True,timeout=15)
        calls=trace.read_text().splitlines() if trace.exists() else []
        return result,calls

    def test_migration_failure_preserved_without_ledger_repair_or_seed(self):
        for service in SERVICES:
            with self.subTest(service=service):
                result,calls=self.invoke(service,'migrate',47)
                self.assertEqual(result.returncode,47,result.stderr)
                self.assertEqual(calls,['node_modules/prisma/build/index.js'])
    def test_success_preserves_existing_seed_behavior(self):
        for service,seed in SERVICES.items():
            with self.subTest(service=service):
                result,calls=self.invoke(service,'migrate')
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(calls,['node_modules/prisma/build/index.js']+(['dist/seed.js'] if seed else []))
    def test_serve_does_not_invoke_migration_or_seed(self):
        for service in SERVICES:
            with self.subTest(service=service):
                result,calls=self.invoke(service,'serve')
                self.assertEqual(result.returncode,0,result.stderr)
                self.assertEqual(calls,['dist/main.js'])
    def test_unknown_verb_stops_without_node_execution(self):
        for service in SERVICES:
            with self.subTest(service=service):
                result,calls=self.invoke(service,'unknown-incident-fixture')
                self.assertEqual(result.returncode,1,result.stderr)
                self.assertEqual(calls,[])

if __name__=='__main__':unittest.main()
