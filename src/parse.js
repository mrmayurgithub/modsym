import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ts = require('typescript');

/**
 * Per-file TypeScript AST parsing (syntax only — no Program, no checker).
 *
 * `analyzeFile` reads one declaration file and reports its export surface:
 * - `local`: exported top-level declarations, name → decl records
 *   (overloads preserved as multiple records)
 * - `pendingLocal`: top-level declarations *without* an `export` modifier
 *   (bundled `.d.ts` files declare first and `export {…}` later)
 * - `defaults`: inline `export default class/function X` declarations
 * - `named`: `{ exported, local, src }` export-specifier triples;
 *   `src === null` means same-file
 * - `stars`: `export * from '…'` sources (`export * as ns` excluded:
 *   it never brings bare names into scope)
 * - `imports`: local name → `{ src, imported }` (named, default, namespace)
 * - `exportEq`: `export = X` target; `exportDefault`: `export default X` name
 *
 * Only top-level statements are considered. Anything nested inside
 * `declare namespace` / `declare module` blocks is intentionally invisible:
 * qualified-only members are not bare exports.
 */
export function analyzeFile(file, readFile) {
  const text = readFile(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.External);
  const local = new Map();
  const pendingLocal = new Map();
  const defaults = [];
  const stars = [];
  const named = [];
  const imports = new Map();
  let exportEq = null;
  let exportDefault = null;

  const store = (map, name, rec) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(rec);
  };
  const here = node => ({
    line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    text: sliceNode(sf, node),
  });

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      recordImport(imports, st);
    } else if (ts.isExportDeclaration(st)) {
      recordExport(named, stars, st);
    } else if (ts.isExportAssignment(st)) {
      if (st.isExportEquals) {
        exportEq = st.expression.getText(sf);
      } else if (ts.isIdentifier(st.expression)) {
        exportDefault = st.expression.text;
      }
    } else if (
      ts.isFunctionDeclaration(st) ||
      ts.isClassDeclaration(st) ||
      ts.isInterfaceDeclaration(st) ||
      ts.isTypeAliasDeclaration(st) ||
      ts.isEnumDeclaration(st) ||
      ts.isVariableStatement(st) ||
      ts.isModuleDeclaration(st)
    ) {
      const exported = hasModifier(st, ts.SyntaxKind.ExportKeyword);
      const isDefault = hasModifier(st, ts.SyntaxKind.DefaultKeyword);
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (d.name && ts.isIdentifier(d.name)) {
            const at = here(st);
            const rec = { kind: 'const', line: at.line, text: at.text, exported };
            store(exported ? local : pendingLocal, d.name.text, rec);
            if (isDefault && exported) defaults.push({ name: d.name.text, rec });
          }
        }
      } else {
        const name = st.name ? st.name.text : null;
        if (name) {
          const at = here(st);
          const rec = { kind: kindOf(st), line: at.line, text: at.text, exported };
          store(exported ? local : pendingLocal, name, rec);
          if (isDefault && exported) defaults.push({ name, rec });
        }
      }
    }
  }
  return { sf, local, pendingLocal, defaults, stars, named, imports, exportEq, exportDefault };
}

function recordImport(imports, st) {
  const src = st.moduleSpecifier.text;
  const clause = st.importClause;
  if (!clause) return;
  if (clause.name) imports.set(clause.name.text, { src, imported: 'default' });
  if (clause.namedBindings) {
    if (ts.isNamedImports(clause.namedBindings)) {
      for (const e of clause.namedBindings.elements) {
        imports.set(e.name.text, {
          src,
          imported: e.propertyName ? e.propertyName.text : e.name.text,
        });
      }
    } else if (ts.isNamespaceImport(clause.namedBindings)) {
      imports.set(clause.namedBindings.name.text, { src, imported: '*' });
    }
  }
}

function recordExport(named, stars, st) {
  if (!st.moduleSpecifier) {
    // Same-file `export {A, B as C}`.
    const clause = st.exportClause;
    if (clause && ts.isNamedExports(clause)) {
      for (const e of clause.elements) {
        named.push({
          exported: e.name.text,
          local: e.propertyName ? e.propertyName.text : e.name.text,
          src: null,
        });
      }
    }
    return;
  }
  const src = st.moduleSpecifier.text;
  if (st.exportClause && ts.isNamespaceExport(st.exportClause)) return;
  if (st.exportClause && ts.isNamedExports(st.exportClause)) {
    for (const e of st.exportClause.elements) {
      named.push({
        exported: e.name.text,
        local: e.propertyName ? e.propertyName.text : e.name.text,
        src,
      });
    }
    return;
  }
  stars.push(src);
}

function hasModifier(node, kind) {
  return (node.modifiers || []).some(m => m.kind === kind);
}

function kindOf(node) {
  if (ts.isFunctionDeclaration(node)) return 'function';
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isEnumDeclaration(node)) return 'enum';
  if (ts.isVariableStatement(node)) return 'const';
  if (ts.isModuleDeclaration(node)) return 'namespace';
  return 'unknown';
}

function sliceNode(sf, node) {
  try {
    return sf.text.slice(node.getStart(sf), node.getEnd()).slice(0, 600);
  } catch {
    return sf.text.slice(node.pos, node.end).slice(0, 600);
  }
}
