import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeStep } from '../web/src/components/tool-labels.ts';

const expect = (v: any) => ({ toBe: (x: unknown) => assert.equal(v, x), toMatchObject: (o: Record<string, unknown>) => { for (const k in o) assert.equal(v[k], o[k]); } });

const s = (title: string, toolKind: string, rawInput: unknown, status = 'completed', content: any[] = []) => describeStep({ title, toolKind, status, rawInput, content });

describe('describeStep', () => {
  test('read: sentence by status, relative to My files', () => {
    const i = { file_path: '/files/Projects/q3.csv' };
    expect(s('Read /files/Projects/q3.csv', 'read', i, 'in_progress').text).toBe('Reading Projects/q3.csv…');
    const d = s('Read /files/Projects/q3.csv', 'read', i);
    expect(d).toMatchObject({ text: 'Read Projects/q3.csv', object: 'Projects/q3.csv', detail: '/files/Projects/q3.csv' });
    expect(s('Read /files/Projects/q3.csv', 'read', i, 'failed').text).toBe("Couldn't read Projects/q3.csv");
    expect(s('Read /srv/data/notes.md', 'read', { file_path: '/srv/data/notes.md' }).text).toBe('Read notes.md');
  });
  test('agent-internal paths', () => {
    const p = '/tmp/claude-1000/-files/25659cf2-1111/tasks/b0gnkvpng.output';
    const d = s(`Read ${p}`, 'read', { file_path: p });
    expect(d.text).toBe("Checked a sub-agent's progress");
    expect(d.detail).toBe(p);
    expect(s('Read /tmp/x/a.txt', 'read', { file_path: '/tmp/x/a.txt' }).text).toBe('Read a working file');
    expect(s('Read /root/.claude/x.json', 'read', { file_path: '/root/.claude/x.json' }).text).toBe('Read a working file');
    expect(s('Read /claude-home/a', 'read', { file_path: '/claude-home/a' }).text).toBe('Read a working file');
  });
  test('edit, create, delete, move', () => {
    expect(s('Edit /files/a/b.md', 'edit', { file_path: '/files/a/b.md' }).text).toBe('Edited a/b.md');
    expect(s('Write /files/n.md', 'edit', { file_path: '/files/n.md' }).text).toBe('Created n.md');
    expect(s('x', 'delete', { path: '/files/old.txt' }).text).toBe('Deleted old.txt');
    expect(s('x', 'move', { from: '/files/a.txt', to: '/files/b/a.txt' }).text).toBe('Moved a.txt to b/a.txt');
  });
  test('search', () => {
    expect(s('Grep nap', 'search', { pattern: 'nap' }).text).toBe('Searched your files for “nap”');
    expect(s('Glob *.md', 'search', { pattern: '*.md' }).text).toBe('Looked for files matching *.md');
    expect(s('WebSearch cats', 'fetch', { query: 'cats' }).text).toBe('Searched the web for “cats”');
  });
  test('fetch shows the host only', () => {
    const d = s('WebFetch https://www.example.com/a/b?x=1', 'fetch', { url: 'https://www.example.com/a/b?x=1' });
    expect(d).toMatchObject({ text: 'Opened example.com', detail: 'https://www.example.com/a/b?x=1' });
  });
  test('bash: description or generic', () => {
    const d = s('Bash Create test file in /tmp', 'execute', { command: 'echo hi > /tmp/t.txt', description: 'Create test file in /tmp' });
    expect(d).toMatchObject({ text: 'Create test file', detail: 'echo hi > /tmp/t.txt' });
    expect(s('Bash ls -la', 'execute', { command: 'ls -la' })).toMatchObject({ text: 'Ran a command', detail: 'ls -la' });
    expect(s('Bash ls', 'execute', { command: 'ls' }, 'failed').text).toBe("Couldn't run the command");
  });
  test('a step the user did not allow says so; a failed one stays "Couldn\'t"', () => {
    const no = (title: string, kind: string, i: unknown) => describeStep({ title, toolKind: kind, status: 'failed', allowed: false, rawInput: i }).text;
    expect(no('Write /files/note.txt', 'edit', { file_path: '/files/note.txt' })).toBe("Didn't create note.txt — you didn't allow it");
    expect(no('Bash ls', 'execute', { command: 'ls', description: 'List files' })).toBe("Didn't list files — you didn't allow it");
    expect(no('Bash ls', 'execute', { command: 'ls' })).toBe("Didn't run the command — you didn't allow it");
    expect(no('WebFetch https://example.com', 'fetch', { url: 'https://example.com' })).toBe("Didn't open example.com — you didn't allow it");
    expect(s('Write /files/note.txt', 'edit', { file_path: '/files/note.txt' }, 'failed').text).toBe("Couldn't create note.txt");
  });
  test('mcp tools', () => {
    expect(s('mcp__playwright_ab12__browser_navigate', 'other', {}).text).toBe('Used Playwright: browser navigate');
  });
  test('other: de-technicalised title', () => {
    expect(s('TodoWrite', 'other', {}).text).toBe('Todo write');
    expect(s('Thinking about the plan', 'think', {}).text).toBe('Thinking about the plan');
  });
});
