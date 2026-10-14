import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const filename = "prune-stale-assistance-recipient-candidates.ts";
const source = readFileSync(
  new URL(`../../apps/api/scripts/${filename}`, import.meta.url),
  "utf8",
);
const options = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
};
const parse = (text) =>
  ts.createSourceFile(filename, text, options.target, true, ts.ScriptKind.TS);
const errors = (result) =>
  result.diagnostics.filter(
    (item) => item.category === ts.DiagnosticCategory.Error,
  );
const compile = (text) =>
  ts.transpileModule(text, {
    compilerOptions: options,
    reportDiagnostics: true,
  });
const executableSql = (sql) =>
  sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const SELECT = `SELECT m.id::text AS "id",
  m.tenant_id::text AS "tenantId", m.client_id::text AS "clientId",
  c.name AS "clientName", c.uei AS "clientUei",
  m.external_id AS "externalId", m.external_name AS "externalName",
  m.confidence AS "confidence", m.confirmed AS "confirmed"
  FROM client_intel_mapping m JOIN clients c ON c.id = m.client_id
  WHERE m.source = $1 AND m.confirmed = false
  AND m.review_status <> 'rejected'`;
const ORDER = "ORDER BY m.confidence DESC, m.id";

/** Compile the actual reader declarations only. Operator imports, dotenv,
 * Prisma construction, main and the pruning/deletion function never execute. */
function reader() {
  const file = parse(source);
  assert.equal(file.parseDiagnostics.length, 0);
  const names = new Set(["withBypass", "loadCandidates"]);
  const declarations = file.statements.filter(
    (node) =>
      (ts.isFunctionDeclaration(node) && names.has(node.name?.text)) ||
      (ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (item) => item.name.getText(file) === "MAPPING_SOURCE",
        )),
  );
  assert.equal(declarations.length, 3);
  const printer = ts.createPrinter();
  const selected = declarations
    .map((node) => printer.printNode(ts.EmitHint.Unspecified, node, file))
    .join("\n");
  const emitted = compile(selected);
  assert.deepEqual(errors(emitted), []);
  const context = vm.createContext({ exports: {} });
  new vm.Script(emitted.outputText, { filename }).runInContext(context);
  assert.equal(typeof context.exports.loadCandidates, "function");
  return context.exports.loadCandidates;
}

async function capture(tenantId) {
  const events = [];
  const rows = [{ id: "synthetic-candidate" }];
  let query;
  const tx = {
    async $executeRawUnsafe(sql) {
      events.push(["bypass", sql]);
      return 1;
    },
    async $queryRaw(strings, ...values) {
      events.push(["query"]);
      query = {
        sql: strings.reduce(
          (text, part, index) => text + (index ? `$${index}` : "") + part,
          "",
        ),
        values,
      };
      return rows;
    },
  };
  // No database client or deletion port exists in this fixture.
  const prisma = {
    async $transaction(callback) {
      events.push(["begin"]);
      const result = await callback(tx);
      events.push(["end"]);
      return result;
    },
  };
  const result = await reader()(prisma, tenantId);
  assert.equal(result, rows);
  assert.deepEqual(events, [
    ["begin"],
    ["bypass", "SELECT set_config('app.bypass_rls', 'on', true)"],
    ["query"],
    ["end"],
  ]);
  return query;
}

test("complete operator parses and its complete compiler output has valid JavaScript syntax", () => {
  assert.equal(parse(source).parseDiagnostics.length, 0);
  const emitted = compile(source);
  assert.deepEqual(errors(emitted), []);
  // Compilation only: never run the complete operator or its import graph.
  assert.doesNotThrow(() => new vm.Script(emitted.outputText, { filename }));
});

test("literal backticks in the two SQL comments reproduce the original parse failure", () => {
  const plain = "-- found no existing, its reviewStatus='rejected'";
  assert.equal(source.split(plain).length - 1, 2);
  const broken = source.replaceAll(
    plain,
    "-- found no `existing`, its reviewStatus='rejected'",
  );
  assert.ok(parse(broken).parseDiagnostics.length > 0);
  assert.ok(errors(compile(broken)).length > 0);
});

test("single-tenant reader retains exact selection, rejected/confirmed filters and bound UUID", async () => {
  const tenantId = "00000000-0000-4000-8000-000000000001";
  const query = await capture(tenantId);
  assert.equal(
    executableSql(query.sql),
    executableSql(`${SELECT} AND m.tenant_id = $2::uuid ${ORDER}`),
  );
  assert.deepEqual(query.values, ["assistance_recipient", tenantId]);
});

test("all-tenant reader retains exact selection and human-decision filters without a tenant binding", async () => {
  const query = await capture(null);
  assert.equal(executableSql(query.sql), executableSql(`${SELECT} ${ORDER}`));
  assert.deepEqual(query.values, ["assistance_recipient"]);
});

test("tenant input remains a parameter even when its text resembles SQL", async () => {
  const tenantId = "'; SELECT forbidden_write; --";
  const query = await capture(tenantId);
  assert.equal(query.sql.includes(tenantId), false);
  assert.deepEqual(query.values, ["assistance_recipient", tenantId]);
});
