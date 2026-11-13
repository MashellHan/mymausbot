import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// TypeScript 7 does not export its old source parser; the Vite React plugin already depends on Babel.
const require = createRequire(import.meta.url);
const { parseSync } = createRequire(require.resolve("@vitejs/plugin-react"))("@babel/core");
const children = (node) => Object.values(node).flatMap((value) => Array.isArray(value) ? value : [value])
  .filter((value) => value && typeof value === "object" && typeof value.type === "string");
const functionTypes = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);

export function electronReadyAwaits(source, filename = "entry.mjs") {
  const tree = parseSync(source, { filename, babelrc: false, configFile: false, parserOpts: { sourceType: "module" } });
  const apps = new Set();
  const modules = new Set();
  for (const statement of tree.program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== "electron") continue;
    for (const binding of statement.specifiers) {
      if (binding.type === "ImportDefaultSpecifier" || binding.type === "ImportNamespaceSpecifier") modules.add(binding.local.name);
      if (binding.type === "ImportSpecifier" && (binding.imported.name ?? binding.imported.value) === "app") apps.add(binding.local.name);
    }
  }
  const isName = (node, name) => node?.type === "Identifier" && node.name === name;
  const isApp = (node) => (node?.type === "Identifier" && apps.has(node.name))
    || (node?.type === "MemberExpression" && !node.computed && isName(node.property, "app")
      && node.object.type === "Identifier" && modules.has(node.object.name));
  const readyCall = (node) => node?.type === "CallExpression" && node.callee.type === "MemberExpression"
    && !node.callee.computed && isApp(node.callee.object) && isName(node.callee.property, "whenReady");
  const containsReady = (node) => readyCall(node) || children(node).some(containsReady);
  const errors = [];
  const visit = (node) => {
    if (functionTypes.has(node.type)) return;
    if (node.type === "AwaitExpression" && containsReady(node.argument)) {
      errors.push(`${filename}:${node.loc.start.line}: await app.whenReady() inside an async function invoked without a top-level await`);
    }
    for (const child of children(node)) visit(child);
  };
  visit(tree.program);
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
