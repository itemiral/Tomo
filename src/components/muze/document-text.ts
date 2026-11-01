// A deliberately small, safe Markdown presentation. No HTML or remote media is fetched.
export function documentText(markdown: string, title = 'Document') {
  const lines = [title, '', ...markdown.split('\n')];
  let fenced = false;
  return lines.map((line, i) => {
    if (line.trim().startsWith('```')) { fenced = !fenced; return ''; }
    if (fenced) return line;
    return line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^>\s?/, '│ ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[Image reference: $1 — not loaded]')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1');
  }).join('\n');
}
