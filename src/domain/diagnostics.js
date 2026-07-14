export function createDiagnostic(severity, message, line = null) {
  return { severity, message, line };
}

export function hasErrors(diagnostics) {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function diagnosticLabel(diagnostic) {
  const line = diagnostic.line == null ? "" : `L${diagnostic.line} `;
  return `${line}${diagnostic.message}`;
}
