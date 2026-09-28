const escapeHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const URL_RE = /https?:\/\/[^\s<>"]+[^\s<>".,;:!?)]/g;

function labelFor(url) {
  const workItem = url.match(/\/_workitems\/edit\/(\d+)/);
  if (workItem) return `#${workItem[1]}`;
  const pullRequest = url.match(/\/pullrequest\/(\d+)/i);
  if (pullRequest) return `!${pullRequest[1]}`;
  return url;
}

export function textToTeamsHtml(text) {
  const source = String(text || '');
  let html = '';
  let last = 0;
  for (const match of source.matchAll(URL_RE)) {
    html += escapeHtml(source.slice(last, match.index));
    html += `<a href="${escapeHtml(match[0])}">${escapeHtml(labelFor(match[0]))}</a>`;
    last = match.index + match[0].length;
  }
  html += escapeHtml(source.slice(last));
  return html.replace(/\n/g, '<br>');
}
