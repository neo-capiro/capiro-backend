"""Generate a local draft only. The Case14 proof pin is deliberately disabled."""
import pathlib,hashlib
BASE=pathlib.Path(__file__).resolve().parent
SOURCE=pathlib.Path('C:/dev/main/meri-c1-20261002/evals/meri/live-v1/lib/windows-capture-spend.py')
text=SOURCE.read_text()
text=text.replace("protocol = runpy.run_path(str(pathlib.Path(__file__).with_name('windows-artifact-protocol.py')))","protocol = runpy.run_path(r'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/lib/windows-artifact-protocol.py')")
text=text.replace("FRESH_AUTHORIZATION =", "# DRAFT: set only after independently reviewed authentic postdeadline proof.\nCASE14_TERMINAL_PROOF_SHA256 = None\nCASE14_TERMINAL_PREFIX25 = '139b6d7199038ca752c553289bf1ebe9c45f14e65956710f82a48301b132e673'\nFRESH_AUTHORIZATION =",1)
old="""            else:
                require(sequence == 24 and row['caseId'] == '20')"""
new="""            elif sequence == 26:
                require(row['caseId'] == '14')
                require(row['captureRunId'] == '5f4312a2-6aa9-4ec8-820d-5717a88402df')
                require(row['reservationId'] == '9b299041-d425-45fa-9a41-439745f4a912')
                require(digest(b''.join(lines[:25])) == CASE14_TERMINAL_PREFIX25)
                require(valid_hash(CASE14_TERMINAL_PROOF_SHA256))
                require(digest(data(proof)) == CASE14_TERMINAL_PROOF_SHA256)
                require(proof['journalBeforeSha256'] == CASE14_TERMINAL_PREFIX25)
                require(proof['chargedCostMicros'] == 1_569_851)
                require(proof['conservativeApprovalCostMicros'] == CASE14_APPROVAL)
                require(proof['approvalBilledActualMicros'] is None)
                require(proof['combinedCommittedCostMicros'] == 2_569_851)
                require(proof['approvalBoundSha256'] == runs[key]['approvalBoundSha256'])
                require(proof['providerAttempts'] == 3 and proof['pendingProviderAttempts'] == 0)
                require(proof['observedAtMs'] > proof['providerDeadlineAtMs'])
                require(proof['failure'] == 'CASE01_SOURCE_TOOL_JOIN_MISMATCH')
                require(proof['captureStatus'] == 'CAPTURE_UNCERTAIN')
            else:
                require(sequence == 24 and row['caseId'] == '20')"""
assert text.count(old)==1
text=text.replace(old,new,1)
old="""                         'reconciliationProofSha256': digest(data(proof))}
            active = None"""
new="""                         'reconciliationProofSha256': digest(data(proof))}
            if sequence == 26:
                conservative_approval += CASE14_APPROVAL
                runs[key].update({'conservativeApprovalCostMicros': CASE14_APPROVAL,
                                  'approvalBilledActualMicros': None,
                                  'approvalOutcomeSha256': proof['approvalOutcomeSha256'],
                                  'projectionTerminalSha256': proof['projectionTerminalSha256']})
            active = None"""
assert text.count(old)==1
text=text.replace(old,new,1)
assert text.count("require(snapshot['eventCount'] in {21, 23})")==1
text=text.replace("require(snapshot['eventCount'] in {21, 23})","require(snapshot['eventCount'] in {21, 23, 25})",1)
(BASE/'windows-capture-spend.draft.py').write_text(text)
print('DRAFT_NATIVE_WRITTEN original='+hashlib.sha256(SOURCE.read_bytes()).hexdigest()+' draft='+hashlib.sha256((BASE/'windows-capture-spend.draft.py').read_bytes()).hexdigest())
