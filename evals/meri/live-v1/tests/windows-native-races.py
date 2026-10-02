"""Opt-in real Windows competing-process probes. Only an explicit scratch root."""
import contextlib
import json
import os
import pathlib
import runpy
import subprocess
import sys
import unittest
import uuid

HELPER = pathlib.Path(__file__).resolve().parents[1] / "lib" / "windows-owned-artifacts.py"
SCRATCH = os.environ.get("MERI_WINDOWS_ARTIFACT_TEST_ROOT")
native = runpy.run_path(str(HELPER)) if sys.platform == "win32" else None


@contextlib.contextmanager
def pinned(path):
    with contextlib.ExitStack() as stack:
        handle = stack.enter_context(native["open_volume"](path.drive.upper()))
        for part in path.parts[1:]:
            handle = stack.enter_context(native["open_child"](handle, part, True))
        yield handle


def attack(action, path, other=None):
    # The child never obtains an internal helper handle or changes parent state.
    code = """
import json,os,pathlib,sys
action,path,other=sys.argv[1:]
try:
 if action=='rename': os.rename(path,other)
 elif action=='write': pathlib.Path(path).write_bytes(b'corrupt')
 elif action=='delete': os.unlink(path)
 elif action=='link': os.link(path,other)
 elif action=='junction':
  os.rename(path,other+'-moved')
  import subprocess
  subprocess.run(['cmd','/c','mklink','/J',path,other],check=True,capture_output=True)
 print(json.dumps({'blocked':False}))
except OSError as error: print(json.dumps({'blocked':True,'winerror':error.winerror}))
"""
    result = subprocess.run([sys.executable, "-I", "-c", code, action, str(path), str(other or "")],
                            capture_output=True, text=True, timeout=10, check=True)
    return json.loads(result.stdout)


@unittest.skipUnless(sys.platform == "win32" and SCRATCH, "explicit Windows scratch root required")
class NativeRaceTests(unittest.TestCase):
    def setUp(self):
        self.base = pathlib.Path(SCRATCH).resolve() / ("race-" + str(uuid.uuid4()))
        self.root = self.base / "owned"
        self.parent = self.root / "case"
        self.outside = self.base / "outside"
        self.parent.mkdir(parents=True)
        self.outside.mkdir()
        self.file = self.parent / "answer.txt"
        self.file.write_bytes(b"original")
        (self.outside / "sentinel.txt").write_bytes(b"untouched")

    def test_pinned_root_cannot_be_renamed_by_competing_process(self):
        with pinned(self.root):
            self.assertTrue(attack("rename", self.root, self.base / "moved")["blocked"])
        self.assertEqual(self.file.read_bytes(), b"original")

    def test_pinned_ancestor_cannot_be_renamed_by_competing_process(self):
        with pinned(self.parent):
            self.assertTrue(attack("rename", self.base, self.base.with_name(self.base.name + "-moved"))["blocked"])

    def test_parent_swap_to_junction_is_blocked_before_relative_create(self):
        with pinned(self.parent) as handle:
            self.assertTrue(attack("junction", self.parent, self.outside)["blocked"])
            with native["open_child"](handle, "new.txt", False, create=True, write=True) as leaf:
                native["write_bytes"](leaf, b"owned")
                self.assertEqual(native["read_bytes"](leaf), b"owned")
        self.assertFalse((self.outside / "new.txt").exists())
        self.assertEqual((self.outside / "sentinel.txt").read_bytes(), b"untouched")

    def test_open_file_blocks_external_rewrite_and_delete(self):
        with pinned(self.parent) as handle:
            with native["open_child"](handle, "answer.txt", False) as leaf:
                self.assertTrue(attack("write", self.file)["blocked"])
                self.assertTrue(attack("delete", self.file)["blocked"])
                self.assertEqual(native["read_bytes"](leaf), b"original")

    def test_preexisting_write_handle_prevents_native_read(self):
        with pinned(self.parent) as handle:
            with native["open_child"](handle, "answer.txt", False, write=True):
                with self.assertRaises(OSError):
                    native["open_child"](handle, "answer.txt", False)

    def test_preexisting_delete_handle_prevents_native_read(self):
        raw = native["Create"](str(self.file), 0x10000, 7, None, 3, 0x00200000, None)
        self.assertNotEqual(raw, native["HANDLE"](-1).value)
        with native["Handle"](raw), pinned(self.parent) as parent:
            with self.assertRaises(OSError):
                native["open_child"](parent, "answer.txt", False)

    def test_new_file_excludes_second_creator_without_overwriting(self):
        with pinned(self.parent) as handle:
            with native["open_child"](handle, "new.txt", False, create=True, write=True) as leaf:
                native["write_bytes"](leaf, b"first")
                self.assertTrue(attack("write", self.parent / "new.txt")["blocked"])
                self.assertEqual(native["read_bytes"](leaf), b"first")
            with self.assertRaises(OSError):
                native["open_child"](handle, "new.txt", False, create=True, write=True)

    def test_owner_held_during_read_blocks_concurrent_replacement(self):
        owner = self.root / "bundle-owner.json"
        owner.write_bytes(b'{"owner":"test"}')
        with pinned(self.root) as handle:
            with native["open_child"](handle, owner.name, False) as leaf:
                self.assertTrue(attack("write", owner)["blocked"])
                self.assertTrue(attack("rename", owner, self.root / "prior.json")["blocked"])
                self.assertEqual(native["read_bytes"](leaf), b'{"owner":"test"}')

    def test_abrupt_helper_exit_leaves_uncommitted_leaf_that_cannot_be_overwritten(self):
        code = """
import contextlib,pathlib,runpy,sys
n=runpy.run_path(sys.argv[1]); p=pathlib.Path(sys.argv[2])
with contextlib.ExitStack() as stack:
 h=stack.enter_context(n['open_volume'](p.drive.upper()))
 for part in p.parts[1:]: h=stack.enter_context(n['open_child'](h,part,True))
 f=stack.enter_context(n['open_child'](h,'partial.bin',False,create=True,write=True))
 n['write_bytes'](f,b'partial')
 print('PINNED',flush=True)
 sys.stdin.readline()
"""
        child = subprocess.Popen([sys.executable, "-I", "-c", code, str(HELPER), str(self.root)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), "PINNED")
            child.terminate()
            child.wait(timeout=10)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=10)
            child.stdin.close()
            child.stdout.close()
            child.stderr.close()
        self.assertNotEqual(child.returncode, 0)
        self.assertFalse((self.root / "capture-manifest.json").exists())
        with pinned(self.root) as handle:
            with self.assertRaises(OSError):
                native["open_child"](handle, "partial.bin", False, create=True, write=True)
        self.assertEqual((self.root / "partial.bin").read_bytes(), b"partial")


if __name__ == "__main__":
    unittest.main(verbosity=2)
