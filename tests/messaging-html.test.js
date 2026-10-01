import test from 'node:test';
import assert from 'node:assert/strict';
import { textToTeamsHtml } from '../src/messaging/html.js';

test('Azure links become short clickable labels and line breaks survive', () => {
  const html = textToTeamsHtml('SEAL: a revisão da !10131 depende de ajuste:\n• #20220: critério <C1> & C2\nhttps://dev.azure.com/org/Projeto/_workitems/edit/20220');
  assert.equal(html, 'SEAL: a revisão da !10131 depende de ajuste:<br>• #20220: critério &lt;C1&gt; &amp; C2<br><a href="https://dev.azure.com/org/Projeto/_workitems/edit/20220">#20220</a>');
});

test('a PR link reads as !id and other links keep their address as the label', () => {
  assert.equal(textToTeamsHtml('veja https://dev.azure.com/org/Projeto/_git/app-web/pullrequest/10122.'),
    'veja <a href="https://dev.azure.com/org/Projeto/_git/app-web/pullrequest/10122">!10122</a>.');
  assert.equal(textToTeamsHtml('doc https://example.com/a?b=1&c=2'), 'doc <a href="https://example.com/a?b=1&amp;c=2">https://example.com/a?b=1&amp;c=2</a>');
});
