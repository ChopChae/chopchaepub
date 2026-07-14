export function stripSourceLines(value) {
  if (Array.isArray(value)) {
    return value.map(stripSourceLines);
  }

  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "line")
        .map(([key, child]) => [key, stripSourceLines(child)])
    );
  }

  return value;
}
