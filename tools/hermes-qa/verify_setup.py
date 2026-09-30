import importlib.util, json, os, sys, unittest, sqlite3
from unittest.mock import patch
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.path.insert(0,str(ROOT))
import context_guard
os.environ['HERMES_HOME']=r'C:\ProgramData\Hermes'
sys.path.insert(0,r'C:\ProgramData\Hermes\hermes-agent')
import hermes_bootstrap
from hermes_cli.kanban_db_connect import connect
from hermes_cli import kanban_db as kb

class SetupTests(unittest.TestCase):
    def test_unknown_window_blocks(self): self.assertFalse(context_guard.decision(0,1,1,1))
    def test_estimated_threshold_blocks(self): self.assertFalse(context_guard.decision(128000,47104,4096,100))
    def test_byte_threshold_blocks(self): self.assertFalse(context_guard.decision(128000,1,4096,57344))
    def test_bounded_request_allowed(self): self.assertTrue(context_guard.decision(128000,12000,4096,30000))
    def test_guard_covers_main_loop(self):
        context_guard.install()
        import agent.conversation_loop as loop
        import agent.turn_preflight_gate as gate
        self.assertIs(loop.run_preflight_gate,gate.run_preflight_gate)
        self.assertTrue(gate.run_preflight_gate._capiro_guard)
        import inspect
        self.assertIn('request_pressure_tokens',inspect.signature(loop.run_preflight_gate).parameters)
    def test_large_tool_outputs_are_bounded(self):
        context_guard.install()
        context_guard.install_surfaces()
        import agent.tool_executor as executor
        budget=executor._budget_for_agent(None)
        self.assertEqual(4000,budget.resolve_threshold('terminal'))
        self.assertEqual(12000,budget.turn_budget)
        self.assertEqual(1000,budget.preview_size)
    def test_worker_cannot_mark_done_via_exposed_lifecycle(self):
        context_guard.install()
        context_guard.install_surfaces()
        import model_tools
        with patch.dict(os.environ,{'HERMES_KANBAN_BOARD':'capiro-qa','HERMES_KANBAN_TASK':'test-owned-task'}):
            names=model_tools._select_tool_names(['kanban'],[],True)
            self.assertNotIn('kanban_complete',names)
            self.assertNotIn('kanban_create',names)
            self.assertIn('kanban_request_review',names)
    def test_native_database_scope_fences_deferred_completion(self):
        context_guard.install_surfaces()
        from tools.registry import registry
        import model_tools
        with patch.dict(os.environ,{'HERMES_KANBAN_BOARD':'','HERMES_KANBAN_TASK':'test-owned-task','HERMES_KANBAN_DB':r'C:\ProgramData\Hermes\kanban\boards\capiro-qa\kanban.db'}):
            self.assertTrue(context_guard.qa_worker_scope())
            names=model_tools._select_tool_names(['kanban'],[],True)
            self.assertNotIn('kanban_complete',names)
            self.assertNotIn('kanban_unblock',names)
            entry=registry.get_entry('kanban_complete')
            self.assertTrue(entry.handler._capiro_parent_only)
            result=json.loads(entry.handler({'task_id':'test-owned-task'}))
            self.assertIn('No mutation performed',result['error'])
    def test_other_board_and_parent_scope_are_preserved(self):
        with patch.dict(os.environ,{'HERMES_KANBAN_BOARD':'','HERMES_KANBAN_TASK':'test-owned-task','HERMES_KANBAN_DB':r'C:\ProgramData\Hermes\kanban\boards\other\kanban.db'}):
            self.assertFalse(context_guard.qa_worker_scope())
        with patch.dict(os.environ,{'HERMES_KANBAN_BOARD':'capiro-qa','HERMES_KANBAN_TASK':''}):
            self.assertFalse(context_guard.qa_worker_scope())
    def test_review_transition_fence(self):
        # Same trigger exercised on private memory database; no actual card edits.
        fence=(ROOT/'continuation/review-before-done.sql').read_text()
        conn=sqlite3.connect(':memory:');conn.execute('CREATE TABLE tasks(id TEXT PRIMARY KEY,status TEXT)');conn.executescript(fence)
        conn.execute("INSERT INTO tasks VALUES('test','running')")
        with self.assertRaises(sqlite3.IntegrityError):conn.execute("UPDATE tasks SET status='done' WHERE id='test'")
        conn.execute("UPDATE tasks SET status='review' WHERE id='test'")
        with self.assertRaises(sqlite3.IntegrityError):conn.execute("UPDATE tasks SET status='done' WHERE id='test'")
        conn.execute("INSERT INTO capiro_qa_parent_verifications VALUES('test','parent independently read actual evidence','test-digest','test-source','test-utc')")
        conn.execute("UPDATE tasks SET status='done' WHERE id='test'")
        self.assertEqual('done',conn.execute('SELECT status FROM tasks').fetchone()[0]);conn.close()
    def test_packet_counts(self):
        import import_packet
        text=Path(r'C:\dev\capiro-qa-evidence\modules\portfolio\1353847cc4aa\packet.md').read_text(encoding='utf-8-sig')
        cases=import_packet.parse_cases(text)
        self.assertEqual(83,len(cases))
        self.assertEqual({'CL':29,'OP':7,'BD':23,'VI':12,'TE':12},{p:sum(c['case_id'].startswith(p+'-') for c in cases) for p in ('CL','OP','BD','VI','TE')})
    def test_ambiguous_packet_fails(self):
        import import_packet
        with self.assertRaises(ValueError): import_packet.parse_cases('No explicit cases')
        with self.assertRaises(ValueError): import_packet.parse_cases('| AA-01 | a | b |\n| AA-01 | c | d |')
    def test_dependency_graph_and_isolation(self):
        with connect(board='capiro-qa') as conn:
            tasks=kb.list_tasks(conn)
            self.assertGreaterEqual(len(tasks),91)
            paths=[t.workspace_path for t in tasks]
            self.assertEqual(len(paths),len(set(paths)))
            self.assertTrue(all(t.workspace_kind=='dir' for t in tasks))
            self.assertEqual(83,sum('qa:portfolio:' in (t.idempotency_key or '') and any((':'+p+'-') in t.idempotency_key for p in ('CL','OP','BD','VI','TE')) for t in tasks))
            self.assertTrue(all(t.max_retries==1 for t in tasks))
            fixture=next(t for t in tasks if t.idempotency_key.endswith(':fixtures'))
            cases=[t for t in tasks if any((':'+p+'-') in t.idempotency_key for p in ('CL','OP','BD','VI','TE'))]
            if fixture.status!='done':
                self.assertTrue(all(t.status=='todo' for t in cases))

if __name__=='__main__':
    suite=unittest.defaultTestLoader.loadTestsFromTestCase(SetupTests)
    result=unittest.TextTestRunner(verbosity=2).run(suite)
    (Path(r'C:\dev\capiro-qa-evidence')/'versioned-setup-tests.json').write_text(json.dumps({'tests':result.testsRun,'failures':len(result.failures),'errors':len(result.errors),'passed':result.wasSuccessful()},indent=2),encoding='utf-8')
    sys.exit(0 if result.wasSuccessful() else 1)
