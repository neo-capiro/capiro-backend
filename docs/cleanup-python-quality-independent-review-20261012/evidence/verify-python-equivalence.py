import ast, copy, hashlib, json, re, subprocess
from pathlib import Path

source='ab0fc946192f3f49ce9e94d66a3d3ac5cf7a94cf'
base='61e9b467295235829e7d8097368ce41b0434818a'
packet=Path('docs/cleanup-python-quality-independent-review-20261012')
paths=['apps/defense-budget-parser/src/capiro_defense_budget_parser/docling_engine.py','apps/defense-budget-parser/src/capiro_defense_budget_parser/paddleocr_engine.py','apps/defense-budget-parser/tests/test_docling_engine.py','apps/defense-budget-parser/tests/test_paddleocr_engine.py','apps/defense-budget-parser/tests/test_pdfplumber_engine.py']
def read(pin,file): return subprocess.check_output(['git','show',pin+':'+file]).decode()
def dump(tree): return ast.dump(tree,include_attributes=False)
def sha(text): return hashlib.sha256(text.encode()).hexdigest()
def named(tree,name): return next(n for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name==name)
def case_names(tree): return sorted(n.name for n in ast.walk(tree) if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name.startswith('test_'))
def normalize_test_imports(tree):
    for node in ast.walk(tree):
        if isinstance(node,(ast.Import,ast.ImportFrom)):
            node.names.sort(key=lambda a:(a.name,a.asname or ''))
        for field,value in ast.iter_fields(node):
            if isinstance(value,list):
                i=0
                while i<len(value):
                    if not isinstance(value[i],ast.Import): i+=1;continue
                    j=i+1
                    while j<len(value) and isinstance(value[j],ast.Import): j+=1
                    value[i:j]=sorted(value[i:j],key=dump)
                    i=j
    return tree
bindings=[]
for file in paths:
    old=read(base,file);new=read(source,file)
    before=ast.parse(old);after=ast.parse(new)
    if file.endswith('/paddleocr_engine.py'):
        fn=named(before,'is_funding_value_text')
        conditional,final=fn.body[-2:]
        assert isinstance(conditional,ast.If) and not conditional.orelse
        assert dump(conditional.body[0])==dump(ast.Return(value=ast.Constant(False)))
        assert dump(final)==dump(ast.Return(value=ast.Constant(True)))
        target=named(after,'is_funding_value_text')
        assert dump(target.body[-1])==dump(ast.Return(value=ast.UnaryOp(op=ast.Not(),operand=conditional.test)))
        fn.body[-2:]=[ast.Return(value=ast.UnaryOp(op=ast.Not(),operand=conditional.test))]
    if file.endswith('/test_paddleocr_engine.py'):
        normalize_test_imports(before);normalize_test_imports(after)
    assert dump(before)==dump(after),file
    assert case_names(ast.parse(old))==case_names(ast.parse(new))
    bindings.append({'path':file,'beforeSha256':sha(old),'afterSha256':sha(new),'runtimeAstEquivalentUnderExactBooleanRewriteAndOnlyDeclaredTestImportSort':True,'testNames':case_names(after)})

old_paddle=read(base,paths[1]);new_paddle=read(source,paths[1])
assert old_paddle.count('    import pypdfium2 as pdfium\n')==1
assert new_paddle.count('    import pypdfium2 as pdfium  # type: ignore[import-untyped]\n')==1
assert old_paddle.count('        from paddleocr import PaddleOCR\n')==1
assert new_paddle.count('        from paddleocr import PaddleOCR  # type: ignore[import-not-found]\n')==1
assert 'type: ignore[assignment]' not in read(source,paths[0])
assert 'type: ignore[assignment]' in read(base,paths[0])
tree=ast.parse(new_paddle)
render=named(tree,'render_page_to_image');create=named(tree,'_create_paddle_ocr')
assert any(isinstance(node,ast.Import) and any(alias.name=='pypdfium2' for alias in node.names) for node in ast.walk(render))
try_node=next(node for node in create.body if isinstance(node,ast.Try))
assert any(isinstance(node,ast.ImportFrom) and node.module=='paddleocr' for node in try_node.body)
assert any(isinstance(node,ast.ExceptHandler) and isinstance(node.type,ast.Name) and node.type.id=='ImportError' for node in try_node.handlers)
assert not any(isinstance(node,(ast.Import,ast.ImportFrom)) and (getattr(node,'module',None)=='paddleocr' or any(a.name=='pypdfium2' for a in getattr(node,'names',[]))) for node in tree.body)

def leaf(text):
    tree=ast.parse(text)
    regex=next(node for node in tree.body if isinstance(node,ast.Assign) and any(isinstance(target,ast.Name) and target.id=='_FUNDING_VALUE_RE' for target in node.targets))
    fn=named(tree,'is_funding_value_text')
    ns={'re':re}
    exec(compile(ast.fix_missing_locations(ast.Module(body=[copy.deepcopy(regex),copy.deepcopy(fn)],type_ignores=[])),'<isolated-funding-leaf>','exec'),ns)
    return ns['is_funding_value_text']
before_fn=leaf(old_paddle);after_fn=leaf(new_paddle)
inputs=[]
for number in range(2001):
    value=str(number)
    inputs.extend([value,value.rjust(4,'0'),f'{number:,}',value+'.0',value+'.50','('+value+')','$'+value,' '+value+' '])
inputs.extend(['',' ','07','223','0','1,234','(1,234)','1,234.00','---','NaN','Infinity','2026-10-12','1e3','1.2.3','1,2','1_000','1%','-$100','1\n','javascript:alert(1)',None,False,0,1,{},[],b'1000'])
def outcome(fn,value):
    try:
        result=fn(value)
        assert type(result) is bool
        return ('result',result)
    except Exception as error:
        return ('error',type(error).__name__,str(error))
outcomes=[]
for value in inputs:
    old=outcome(before_fn,value);new=outcome(after_fn,value)
    assert old==new,(repr(value),old,new)
    outcomes.append((repr(value),old))
parent=subprocess.check_output(['git','rev-parse',source+'^'],text=True).strip()
changed=subprocess.check_output(['git','diff','--name-only',parent,source,'--',':!docs'],text=True).splitlines()
assert sorted(changed)==sorted(paths)
base_tree=dict(row.split('\t',1)[::-1] for row in subprocess.check_output(['git','ls-tree','-r',base],text=True).splitlines())
after_tree=dict(row.split('\t',1)[::-1] for row in subprocess.check_output(['git','ls-tree','-r',source],text=True).splitlines())
newsletter=['apps/workspace/src/newsletters/newsletter-image-revisions.spec.ts','apps/workspace/src/newsletters/newsletter-survey.spec.ts','apps/workspace/src/newsletters/newsletter-stock-image.spec.ts']
for file,entry in base_tree.items():
    if file not in paths+newsletter: assert after_tree.get(file)==entry,file
result={'source':source,'tree':subprocess.check_output(['git','rev-parse',source+'^{tree}'],text=True).strip(),'base':base,'sourcePaths':5,'sourceBindings':bindings,'predicateComparisons':len(inputs),'predicateOutcomesSha256':hashlib.sha256(json.dumps(outcomes).encode()).hexdigest(),'pureLeavesOnlyExecuted':True,'optionalOcrOrPdfiumOrDoclingImported':False,'narrowImportDiagnosticAnnotationsOnly':['import-untyped:pypdfium2','import-not-found:paddleocr'],'existingLazyTryCatchBoundariesExact':True,'oldUnusedAssignmentIgnoreRemoved':True,'noConfigDependencyLockTestCaseOrAssertionChange':True,'allBaselineOutsideFivePythonAndAcceptedThreeNewsletterPathsExact':True,'rootRuffMypyPytestResultsNotExecutedByThisVerifier':True}
packet.joinpath('evidence').mkdir(parents=True,exist_ok=True)
(packet/'evidence/python-equivalence.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'source':source,'paths':5,'beforeAfterPredicateComparisons':len(inputs),'allAstAndStringValuesPreservedUnderDeclaredReturnRewrite':True,'optionalModulesImported':False}))
