import pathlib
BASE=pathlib.Path(__file__).resolve().parent
source=(BASE.parent/'case14-terminal-cost-draft-v1/native-tests.py').read_text()
source=source.replace("BASE/'windows-capture-spend.draft.py'","BASE/'native/windows-capture-spend.py'")
source=source.replace("BASE/'proof.unit.json'","BASE/'proof.json'")
source=source.replace("pathlib.Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/tests/fixtures/case01-failed-receipt-authorization.unit.json')","(BASE/'authorization-exact-retained.json')")
source=source.replace('test_disabled_default_refuses_even_exact_unit_proof','test_removed_proof_pin_refuses_exact_actual_proof')
source=source.replace('UNIT proof is never enabled against live root.','Actual proof, only disposable roots; no live journal reads.')
source=source.replace('Only disposable child and this process are configured for the UNIT proof/time.','Only disposable child and this process set the already-frozen actual proof/time.')
(BASE/'native-tests.py').write_text(source)
