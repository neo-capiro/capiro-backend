from pathlib import Path
repo=Path('C:/dev/main/meri-c1-20261002')
base=Path('C:/dev/main/outputs/meri-c2-20261003/capture-contract-followup-v1/api-red-v2-source')

name='apps/api/src/meri/meri-tools.service.ts'
text=(base/name).read_text()
current=(repo/name).read_text()
start=current.index("      case 'list_memory_proposals': {")
end=current.index("      case 'search_congress_bills':", start)
old="      case 'list_memory_proposals':\n        return readOwnPendingMemoryProposals(ctx, input, this.governedMemoryCandidates);\n"
assert text.count(old)==1
text=text.replace(old,current[start:end])
old="      !(['01','14'].includes(policy?.caseId ?? '') && name === 'search_memory') &&"
assert text.count(old)==1
text=text.replace(old,"      !(['01', '14'].includes(policy?.caseId ?? '') &&\n        (name === 'search_memory' || name === 'list_memory_proposals')) &&")
(repo/name).write_text(text,newline='\n')

name='apps/api/src/meri/meri-capture-policy-readback.ts'
text=(base/name).read_text()
old='      receipt.providerBudget.admissionId !== state.admissionId ||'
assert text.count(old)==1
text=text.replace(old,old+'\n      receipt.providerBudget.maxCostMicros !== state.ledger.limits.maxCostMicros ||')
(repo/name).write_text(text,newline='\n')

name='packages/meriv2-core/src/context/capture-evidence-receipt.ts'
text=(base/name).read_text()
current=(repo/name).read_text()
start=current.index('  /** Observed from the actual raw own-proposal HTTP response')
end=current.index('\n}',start)
needle='  packets: MeriCaptureCompilerPacket[];'
assert text.count(needle)==1
text=text.replace(needle,needle+'\n'+current[start:end])
old="? ['search_memory']"
assert text.count(old)==1
text=text.replace(old,"? ['search_memory', 'list_memory_proposals']")
old='    seen.add(attempt.callId);'
text=text.replace(old,old+"\n    if (attempt.tool !== 'list_memory_proposals' && attempt.proposalRead !== undefined)\n      failures.add('semantic_clock_proposal_read_unproved');")
start=current.index("    } else if (attempt.tool === 'list_memory_proposals') {")
end=current.index('    } else {', start+6)
needle='    } else {\n      const row = controlled[0];'
assert text.count(needle)==1
text=text.replace(needle,current[start:end]+needle)
old='      budget.maxCostMicros > 3_000_000 ||'
assert text.count(old)==1
text=text.replace(old,'      // Match the existing original-readonly admission maximum; the API owner\n      // supplies and rechecks the exact qualified ledger limit.\n      budget.maxCostMicros > 15_000_000 ||')
(repo/name).write_text(text,newline='\n')
