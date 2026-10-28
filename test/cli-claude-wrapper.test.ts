import assert from 'node:assert/strict';
import { test } from 'node:test';
import fx from './fixtures/claude-wrapper/captured.json' with { type: 'json' };
import { Mapper, hookDecision, isSystemPrompt, pasteText, permissionOptions, toolInfo } from '../src/cli-agents/claude-wrapper.ts';

// Real payloads (Claude Code 2.1.310) in, the chat's event shapes out.
const h = fx.hooks as Record<string, any>, t = fx.transcript as Record<string, any>;

test('transcript: text, thinking and tool calls become the chat events; a result completes the call once', () => {
  const m = new Mapper();
  assert.deepEqual(m.line(t.thinking).events, [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I should write the file.' } }]);
  assert.deepEqual(m.line(t.text).events, [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Writing the file now.' } }]);
  const [call] = m.line(t.toolUse).events;
  assert.equal(call.sessionUpdate, 'tool_call'); assert.equal(call.toolCallId, 'toolu_01'); assert.equal(call.title, 'Write /files/out.txt'); assert.equal(call.kind, 'edit'); assert.equal(call.status, 'pending');
  assert.deepEqual(call.content, [{ type: 'diff', path: '/files/out.txt', oldText: null, newText: 'hello from the model\n' }]);
  const done = m.line(t.toolResult).events;
  assert.deepEqual(done, [{ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'completed' }], 'a finished edit keeps its diff');
  assert.deepEqual(m.hook('PostToolUse', h.PostToolUse), [], 'the hook after the transcript says nothing new');
});

test('hooks and transcript agree: a tool is announced once whichever comes first', () => {
  const a = new Mapper();
  assert.equal(a.hook('PreToolUse', h.PreToolUse)[0].status, 'in_progress');
  assert.deepEqual(a.line(t.toolUse).events, [], 'the transcript line adds nothing after PreToolUse');
  assert.equal(a.hook('PostToolUse', h.PostToolUse)[0].status, 'completed');
  const b = new Mapper();
  b.line(t.toolUse);
  assert.deepEqual(b.hook('PreToolUse', h.PreToolUse), [{ sessionUpdate: 'tool_call_update', toolCallId: 'toolu_01', status: 'in_progress' }]);
});

test('a denied tool fails, with the reason', () => {
  const m = new Mapper();
  m.hook('PreToolUse', h.PreToolUse);
  const [u] = m.hook('PostToolUse', h.PostToolUseDenied);
  assert.equal(u.status, 'failed'); assert.equal(u.content[0].content.text, 'The user said no from the chat.');
  const n = new Mapper(); n.line(t.toolUse);
  assert.equal(n.line(t.toolDenied).events[0].status, 'failed');
});

test('turn ends and interrupts; side chains and attachments are ignored', () => {
  const m = new Mapper();
  assert.equal(m.line(t.turnDuration).end, 'done');
  assert.equal(m.line(t.interrupted).end, 'interrupted');
  assert.deepEqual(m.line(t.attachment), { events: [] });
  assert.deepEqual(m.line({ ...t.text, isSidechain: true }), { events: [] });
  assert.deepEqual(m.line(t.prompt).events, [], 'prompts are logged from the UserPromptSubmit hook, not the transcript');
});

test('sub-agents: the Agent call is a tool call with its input; the sub-agent\'s own lines and hooks go to its own mapper, never the main one', () => {
  const m = new Mapper(), sub = new Mapper(true);
  const [c] = m.hook('PreToolUse', h.AgentPreToolUse);
  assert.equal(c.rawInput.subagent_type, 'general-purpose'); assert.equal(c.title, 'Agent sub job'); assert.equal(c.kind, 'think');
  assert.deepEqual(m.claimAgent(), { id: 'toolu_04', description: 'sub job', type: 'general-purpose' });
  assert.equal(m.claimAgent(), undefined, 'one sub-agent per Agent call');
  assert.deepEqual(m.line({ ...t.text, isSidechain: true }), { events: [] }, 'a side chain line is not the main conversation');
  assert.deepEqual(sub.line(t.text), { events: [] }, 'and a main line is not the sub-agent\'s');
  assert.equal(sub.line({ ...t.text, isSidechain: true }).events.length, 1);
  assert.deepEqual(sub.line({ type: 'user', isSidechain: true, message: { role: 'user', content: 'SUBWORK please' } }).events, [{ hefyn: 'user', text: 'SUBWORK please' }], 'the brief');
  const [w] = sub.hook('PreToolUse', h.SubagentToolPreToolUse);
  assert.equal(w.toolCallId, 'toolu_05'); assert.equal(sub.toolFor({ tool_name: 'Write', tool_input: h.SubagentToolPreToolUse.tool_input }), 'toolu_05');
  assert.equal(m.has('toolu_05'), false);
});

test('text blocks without anything between them are separate paragraphs; a tool or a new turn starts fresh', () => {
  const m = new Mapper(), text = (s: string) => ({ ...t.text, message: { ...t.text.message, content: [{ type: 'text', text: s }] } });
  assert.equal(m.line(text('into your files.')).events[0].content.text, 'into your files.');
  assert.equal(m.line(text('Done.')).events[0].content.text, '\n\nDone.');
  m.line(t.toolUse);
  assert.equal(m.line(text('After the tool.')).events[0].content.text, 'After the tool.');
  m.line(t.turnDuration);
  assert.equal(m.line(text('Next turn.')).events[0].content.text, 'Next turn.');
});

test('"allow for this session" stays in the session: a suggestion that names a settings file is not written there', () => {
  const b = { permission_suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'localSettings' }, { type: 'setMode', mode: 'acceptEdits', destination: 'session' }] };
  const d = (hookDecision(b, 'allow_session') as any).hookSpecificOutput.decision;
  assert.deepEqual(d.updatedPermissions.map((s: any) => s.destination), ['session', 'session']);
  assert.equal(d.updatedPermissions[0].rules[0].ruleContent, 'ls:*');
  assert.equal((hookDecision(b, 'allow') as any).hookSpecificOutput.decision.updatedPermissions, undefined);
});

test('permission questions: options, the tool they belong to, and the answers', () => {
  const m = new Mapper();
  m.hook('PreToolUse', h.PreToolUse);
  assert.equal(m.toolFor(h.PermissionRequest), 'toolu_01');
  assert.deepEqual(permissionOptions(h.PermissionRequest).map((o) => o.optionId), ['allow', 'allow_session', 'deny']);
  assert.deepEqual(permissionOptions({}).map((o) => o.optionId), ['allow', 'deny']);
  assert.deepEqual(hookDecision(h.PermissionRequest, 'allow'), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.deepEqual(hookDecision(h.PermissionRequest, 'allow_session').hookSpecificOutput.decision.updatedPermissions, h.PermissionRequest.permission_suggestions);
  assert.equal(hookDecision(h.PermissionRequest, 'deny').hookSpecificOutput.decision.behavior, 'deny');
  assert.deepEqual(hookDecision(h.PermissionRequest, null), {}, 'no answer: Claude Code asks in its terminal');
  m.hook('PostToolUse', h.PostToolUse);
  assert.equal(m.toolFor(h.PermissionRequest), undefined, 'a finished tool is not asked about');
});

test('edits show as diffs; todo lists as plans; other tools get a short title', () => {
  assert.deepEqual(toolInfo('Edit', { file_path: '/files/a', old_string: 'x', new_string: 'y' }).content, [{ type: 'diff', path: '/files/a', oldText: 'x', newText: 'y' }]);
  assert.equal(toolInfo('Bash', { command: 'ls', description: 'List files' }).title, 'Bash List files');
  const [p] = new Mapper().hook('PreToolUse', { tool_name: 'TodoWrite', tool_use_id: 'x', tool_input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }] } });
  assert.deepEqual(p.entries.map((e: any) => e.status), ['completed', 'pending']);
});

test('text for the paste is safe; prompts Claude Code made up are recognised', () => {
  assert.equal(pasteText('a\r\nb\x1b[201~c\x00'), 'a\nb[201~c');
  assert.ok(isSystemPrompt(h.TaskNotificationPrompt.prompt));
  assert.ok(!isSystemPrompt(h.UserPromptSubmit.prompt));
  assert.ok(!isSystemPrompt('<b>bold</b> question'));
});

test('an image in a tool result reaches the chat, whether the hook finished the tool first or not', () => {
  const res = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: [{ type: 'text', text: 'ok' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] } };
  const want = [{ type: 'content', content: { type: 'text', text: 'ok' } }, { type: 'content', content: { type: 'image', data: 'AAAA', mimeType: 'image/png' } }];
  const open = new Mapper(); open.hook('PreToolUse', { tool_use_id: 'img', tool_name: 'Read', tool_input: { file_path: '/a.png' } });
  assert.deepEqual(open.line(res).events, [{ sessionUpdate: 'tool_call_update', toolCallId: 'img', status: 'completed', content: want }]);
  const hooked = new Mapper(); hooked.hook('PreToolUse', { tool_use_id: 'img', tool_name: 'Read', tool_input: { file_path: '/a.png' } }); hooked.hook('PostToolUse', { tool_use_id: 'img', tool_name: 'Read', tool_input: {}, tool_response: {} });
  assert.deepEqual(hooked.line(res).events, [{ sessionUpdate: 'tool_call_update', toolCallId: 'img', content: want }]);
  const big = new Mapper(); big.hook('PreToolUse', { tool_use_id: 'img', tool_name: 'Read', tool_input: {} });
  const huge = { ...res, message: { content: [{ type: 'tool_result', tool_use_id: 'img', content: [{ type: 'image', source: { media_type: 'image/png', data: 'x'.repeat(5_000_001) } }] }] } };
  assert.match((big.line(huge).events[0] as any).content[0].content.text, /too large/);
});

test('texts around a tool the hook already announced stay separate paragraphs', () => {
  const m = new Mapper();
  m.hook('PreToolUse', h.PreToolUse); // out of order: the row exists before the texts around it are read
  const say = (text: string) => m.line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }).events[0].content.text;
  assert.equal(say('The sub-agent finished and said: all quiet.'), 'The sub-agent finished and said: all quiet.');
  assert.deepEqual(m.line(t.toolUse).events, []);
  m.line(t.toolResult);
  assert.equal(say("I'll write that note into your files."), "\n\n" + "I'll write that note into your files.");
});
