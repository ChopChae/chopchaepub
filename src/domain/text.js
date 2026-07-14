export function countLinesBefore(text, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

export function stripLineComment(line, marker) {
  return splitLineComment(line, marker).source;
}

export function splitLineComment(line, marker) {
  const index = line.indexOf(marker);
  if (index === -1) {
    return {
      source: line,
      comment: null
    };
  }

  return {
    source: line.slice(0, index),
    comment: line.slice(index + marker.length).trim()
  };
}

export function isBlankOrComment(line, marker) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith(marker);
}

export function splitCsv(text) {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
