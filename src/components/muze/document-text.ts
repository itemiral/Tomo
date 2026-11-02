// A deliberately small, safe Markdown presentation. No HTML or remote media is fetched.
const internalMarker = /^<!-- muze-(learned|entry:[a-f0-9]{24}):(start|end) -->$/;
export function documentLines(markdown: string) {
  return markdown.split('\n').filter(line => !internalMarker.test(line.trim()));
}

// Map a visible text edit back to the source. Markers retain their identity when
// their text is edited; deleting across a boundary removes that pair. Never
// attach a removed entry's identity to unrelated replacement text.
export function documentEditSource(source: string, edited: string): string {
  const markers: { key: string; side: string; text: string; offset: number; mapped?: number }[] = [];
  const lines: string[] = [];
  let length = 0;
  for (const line of source.split('\n')) {
    const match = line.trim().match(internalMarker);
    if (match) markers.push({ key: match[1], side: match[2], text: line, offset: length + (lines.length ? 1 : 0) });
    else { length += line.length + (lines.length ? 1 : 0); lines.push(line); }
  }
  if (!markers.length) return edited;
  const previous = lines.join('\n');
  if (previous === edited) return source;
  let first = 0, oldEnd = previous.length, newEnd = edited.length;
  while (first < oldEnd && first < newEnd && previous[first] === edited[first]) first++;
  while (oldEnd > first && newEnd > first && previous[oldEnd - 1] === edited[newEnd - 1]) { oldEnd--; newEnd--; }
  const change = newEnd - oldEnd;
  for (const marker of markers) {
    const position = Math.min(marker.offset, previous.length);
    if (position < first || position === first && marker.side === 'start') marker.mapped = position;
    else if (position > oldEnd || position === oldEnd && marker.side === 'end') marker.mapped = position + change;
    else if (first === oldEnd) marker.mapped = position + (marker.side === 'end' ? change : 0);
    if (marker.mapped !== undefined && marker.mapped > 0 && marker.mapped < edited.length && edited[marker.mapped - 1] !== '\n') marker.mapped = undefined;
  }
  const pairs = new Map<string, typeof markers>();
  for (const marker of markers) pairs.set(marker.key, [...(pairs.get(marker.key) || []), marker]);
  // A deletion can share a prefix with the next bullet. Recover that unchanged
  // neighbor only when its complete body has exactly one match in the draft.
  for(const [key,pair] of pairs){
    if(key==='learned'||pair.length!==2||pair.every(marker=>marker.mapped!==undefined))continue;
    const body=previous.slice(Math.min(pair[0].offset,previous.length),Math.min(pair[1].offset,previous.length));
    const index=body.trim()?edited.indexOf(body):-1;
    if(index>=0&&(index===0||edited[index-1]==='\n')&&edited.indexOf(body,index+1)<0){pair[0].mapped=index;pair[1].mapped=index+body.length;}
  }
  const valid = new Set([...pairs].flatMap(([key, pair]) => pair.length === 2 && pair[0].side === 'start' && pair[1].side === 'end' && pair.every(marker => marker.mapped !== undefined) && pair[0].mapped! <= pair[1].mapped! && edited.slice(pair[0].mapped, pair[1].mapped).trim() ? [key] : []));
  if (!valid.has('learned')) return edited;
  const insertions = new Map<number, string[]>();
  for (const marker of markers) if (valid.has(marker.key)) insertions.set(marker.mapped!, [...(insertions.get(marker.mapped!) || []), marker.text]);
  let restored = edited;
  for (const [position, values] of [...insertions].sort(([a], [b]) => b - a)) {
    const atEnd = position === edited.length && position > 0 && edited[position - 1] !== '\n';
    const addition = atEnd ? '\n' + values.join('\n') : values.join('\n') + '\n';
    restored = restored.slice(0, position) + addition + restored.slice(position);
  }
  return restored;
}
export function documentText(markdown: string, title = 'Document') {
  const lines = [title, '', ...documentLines(markdown)];
  let fenced = false;
  return lines.map((line, i) => {
    if (line.trim().startsWith('```')) { fenced = !fenced; return ''; }
    if (fenced) return line;
    return line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^>\s?/, '│ ')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '[Image reference: $1 — not loaded]')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1');
  }).join('\n');
}
