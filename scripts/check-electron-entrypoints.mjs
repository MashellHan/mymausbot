import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export function electronReadyAwaits(source, filename = "entry.mjs") {
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const apps = new Set();
  const modules = new Set();
  for (const statement of tree.statements) {
    if (!ts.isImportDeclaration(statement) || statement.moduleSpecifier.text !== "electron") continue;
    if (statement.importClause?.name) modules.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) modules.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) if ((binding.propertyName ?? binding.name).text === "app") apps.add(binding.name.text);
    }
  }
  const isApp = (node) => (ts.isIdentifier(node) && apps.has(node.text))
    || (ts.isPropertyAccessExpression(node) && node.name.text === "app"
      && ts.isIdentifier(node.expression) && modules.has(node.expression.text));
  const readyCall = (node) => ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && isApp(node.expression.expression) && node.expression.name.text === "whenReady";
  const containsReady = (node) => readyCall(node) || Boolean(ts.forEachChild(node, containsReady));
  const errors = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) && containsReady(node.expression)) {
      const { line } = tree.getLineAndCharacterOfPosition(node.getStart(tree));
      errors.push(`${filename}:${line + 1}: await app.whenReady() inside an async function invoked without a top-level await`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return errors;
}

export function checkElectronEntrypoints(root = process.cwd()) {
  return ["electron", "scripts"].flatMap((directory) => readdirSync(join(root, directory), { recursive: true, encoding: "utf8" })
    .filter((name) => /\.(mjs|js)$/.test(name) && !/\.test\.(mjs|js)$/.test(name))
    .flatMap((name) => {
      const file = join(directory, name);
      return electronReadyAwaits(readFileSync(join(root, file), "utf8"), file);
    }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkElectronEntrypoints();
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log("Electron entrypoints do not await app readiness during module evaluation.");
}
