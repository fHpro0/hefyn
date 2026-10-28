import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { Renderer } from '@openuidev/react-lang';
import { skillMarkdown, SKILL_FILE } from '../scripts/openui-skill.ts';
import { library } from '../web/src/components/openui/library.tsx';
import { actionOf, formLines } from '../web/src/components/openui/OpenUIBlock.tsx';
import { profileOf } from '../src/cli-agents/profiles.ts';
import { planSession } from '../src/cli-agents/session-config.ts';

test('the generated openui skill is current with the library (run `bun run openui:skill`)', () => {
  assert.equal(readFileSync(SKILL_FILE, 'utf8'), skillMarkdown());
});

test('every agent session gets the openui skill, with or without an Assistant', () => {
  for (const id of ['claude-acp', 'codex-acp', 'opencode']) {
    const profile = profileOf(id)!, p = planSession({ profile, base: 'http://127.0.0.1:47000', skills: [], helpers: [], mcp: [] });
    const seed = p.stdin.find((s) => s.path === `${profile.skillsDir}/openui/SKILL.md`);
    assert.match(seed && 'text' in seed ? seed.text : '', /^---\nname: openui\n/, id);
  }
});

const sample = `root = Stack([card, form, ask])
card = Card("Status", [KeyValue([["Branch", "main"], ["Tests", 42]]), Tag("green", "ok"), DataTable(["Name", "Size"], [["a", 1], ["b", 2]])])
form = Form("f", [TextField("who", "Name"), SelectField("kind", "Kind", ["x", "y"]), CheckField("ok", "Fine?"), Button("Send", @ToAssistant("Here you go"))])
ask = Choices(["Yes", "No"])`;

test('a sample using the library renders without errors', () => {
  const errors: unknown[] = [];
  const html = renderToString(createElement(Renderer, { response: sample, library, onError: (e) => errors.push(...e) }));
  assert.deepEqual(errors, []);
  assert.match(html, /Status/);
  assert.match(html, /Yes/);
  assert.match(html, /Send/);
});

test('actions: ToAssistant sends the message with the form values, OpenUrl opens http(s) only', () => {
  const form = { f: { who: { value: 'Ann', componentType: 'TextField' }, ok: { value: true, componentType: 'CheckField' } }, $x: 1 };
  assert.deepEqual(formLines(form), ['who: Ann', 'ok: true']);
  assert.deepEqual(actionOf({ type: 'continue_conversation', params: {}, humanFriendlyMessage: 'Send', formState: form }), { send: 'Send\nwho: Ann\nok: true' });
  assert.deepEqual(actionOf({ type: 'open_url', params: { url: 'https://example.com/a' }, humanFriendlyMessage: '' }), { open: 'https://example.com/a' });
  assert.equal(actionOf({ type: 'open_url', params: { url: 'javascript:alert(1)' }, humanFriendlyMessage: '' }), undefined);
  assert.equal(actionOf({ type: 'custom', params: {}, humanFriendlyMessage: '' }), undefined);
});
