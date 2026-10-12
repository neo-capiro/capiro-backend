# Independent repair review at 721bfd482

Source `721bfd4825bfccd819be50172ed712023891f978`, tree
`befb2cd1b4c5ba09223b4d327506706d7c007cdd`, closes all 24 original independent
expectations. The exact old corpus is retained; a derived runner changes only
head/tree provenance and the result filename. New receipts do not overwrite
the original 17-red result or initial rejection packet.

All 65 current author controls pass and all 31 original full names occur exactly
once. The actual current CLI returns one profile, 168 files and no errors; help
exits zero and unknown arguments exit one. The only five non-doc changes from
PR2412 are the guard, its tests/data, the root package alias and CI step. All
application/package-library source remains unchanged. The existing Strategy
profile protects only the original `DOCUMENT_TYPES` and `TEMPLATE_KEY_BY_TYPE`
vocabulary; report conversion is still pending.

The broader independent corpus records 24 passes and three new red expectations
among 27 probes. **This source is not accepted yet.**

1. An extra runtime named import of an owned identifier from an unknown relative
   module (`import {canonicalRoute as other} from './barrel.js'`) is accepted.
   The census runs only when the module path already normalizes to the owner.
   The finite profile cannot claim closure over all owned-name runtime imports
   while allowing that source form. A static, bounded refusal does not require
   resolving or evaluating the unknown module.
2. An extra extensionless owner import (`'./registry'`) is likewise accepted.
   Actual TypeScript/Node resolution is outside this guard's claim; the source
   protocol should refuse that unsupported relative form rather than letting
   it hide an additional owned-name consumer.
3. TypeScript `import other = require('./registry.js')` is accepted because the
   AST form is `ImportEqualsDeclaration`, not the literal call expression
   currently scanned. A bounded owner-import refusal must inspect that finite
   source form, independently of whether a later native compiler permits it.

Four further syntactic ambient-export probes also fail: `export declare`
function, variable, class and enum declarations are accepted as runtime owners.
Their kind and named export do not establish a runtime declaration: `declare`
marks erased ambient source. Runtime owner proof must refuse ambient
declarations (including declaration-file context), and missing function bodies,
while retaining separately bounded type metadata if that is deliberately
supported. The exact four red vectors/results remain in
`evidence/ambient-export-probes.{mjs,json}`. No source emit or evaluation was used
to establish this syntactic distinction.

Other independently probed forms pass: nested object/array/rest bindings and
parameters, named class expressions, quoted/static-computed methods/fields,
accessors, namespace/side-effect/literal dynamic/require owner imports, genuine
runtime uses with additional erased type references, type-only export refusal,
syntax refusal, and full variable-statement envelopes including multi-variable
declarations. Renamed destructuring property keys correctly remain different
from binding names.

The reserved-name census is explicitly conservative: it includes parameter,
property, expression and implementation names. It does not prove arbitrary
copies under new names, calculated module/property aliases, control-flow
reachability, runtime type correctness, filesystem/OS authority or database/
security behavior. Sources remain inert data; only the guard/compiler code is
evaluated. No application import or handler/provider/DB/native execution occurs.

Reacceptance needs a new exact repair head/tree, unchanged original evidence and
unchanged independent vectors with new result filenames. Parent ownership
coordination still holds all four application extractions; no carrier/application
edit or retirement is authorized by these controls.
