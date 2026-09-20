import ts from 'typescript'

const forbiddenSource = /(?:sourceMappingURL|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:\.\.\/){3}docs)/iu
const forbiddenRuntimeImport = /(?:from|import|require)\s*[^\n]{0,80}@(?:deepseek-ai|dsh-backend-team)\//iu
const sensitiveName = /^(?:password|secret|credential|api[_-]?key)$/iu

/** Heuristic artifact scan: literal secrets are values; type names and runtime references are not. */
export function containsSensitiveOrUnresolvedContent(content, filename = 'artifact.js') {
  // Declaration bundles may retain type-only references to private workspace
  // packages; they are not runtime imports. JavaScript/JSON artifacts must
  // still be self-contained and reject those references.
  if (forbiddenSource.test(content) || (!filename.endsWith('.d.ts') && forbiddenRuntimeImport.test(content))) return true
  const source = ts.createSourceFile(filename, content, ts.ScriptTarget.Latest, true, filename.endsWith('.json') ? ts.ScriptKind.JSON : ts.ScriptKind.TS)
  let found = false
  const name = (node) => {
    if (!node) return ''
    if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text
    if (ts.isPropertyAccessExpression(node)) return node.name.text
    if (ts.isComputedPropertyName(node)) return name(node.expression)
    if (ts.isElementAccessExpression(node)) return name(node.argumentExpression)
    return ''
  }
  const isNonemptyLiteral = (node) => node && ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text.length > 0 : ts.isNumericLiteral(node))
  const visit = (node) => {
    if (found) return
    if ((ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node) || ts.isPropertyDeclaration(node) || ts.isBindingElement(node)) && sensitiveName.test(name(node.name)) && isNonemptyLiteral(node.initializer)) found = true
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && sensitiveName.test(name(node.left)) && isNonemptyLiteral(node.right)) found = true
    if (ts.isPropertySignature(node) && sensitiveName.test(name(node.name)) && node.type && ts.isLiteralTypeNode(node.type) && isNonemptyLiteral(node.type.literal)) found = true
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}
