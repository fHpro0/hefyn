import assert from 'node:assert/strict';
import { test } from 'node:test';
import { between, canDrop, childrenOf, depthOf, folderPath, heightOf, insertAround, subtreeIds, zoneOf } from '../web/src/modules/folders/chat-tree.ts';

const F = (id: string, parentId: string | null, projectId: string | null = null, position = 1, name = id) => ({ id, name, parentId, projectId, position });
const folders = [F('a', null), F('b', 'a'), F('c', 'b'), F('x', null, 'p1', 2, 'X'), F('y', null, 'p1', 1, 'Y')];

test('tree helpers: subtree, depth, height, path, children order', () => {
  assert.deepEqual([...subtreeIds(folders, 'a')].sort(), ['a', 'b', 'c']);
  assert.deepEqual([depthOf(folders, 'c'), depthOf(folders, null), heightOf(folders, 'a'), heightOf(folders, 'c')], [3, 0, 3, 1]);
  assert.equal(folderPath(folders, [{ id: 'p1', title: 'Kunden' } as any], 'c'), 'a / b / c');
  assert.equal(folderPath(folders, [{ id: 'p1', title: 'Kunden' } as any], 'x'), 'Kunden / X');
  assert.deepEqual(childrenOf(folders, null, 'p1').map((f) => f.id), ['y', 'x']); // by position
  assert.deepEqual(childrenOf(folders, null, 'p1', true).map((f) => f.id), ['x', 'y']); // by name
  assert.deepEqual(childrenOf(folders, null, null).map((f) => f.id), ['a']); // root folders only
});

test('canDrop: no cycles, depth limit', () => {
  assert.equal(canDrop(folders, { folderId: 'a' }, { kind: 'folder', folderId: 'c' }), false); // into its own subtree
  assert.equal(canDrop(folders, { folderId: 'a' }, { kind: 'folder', folderId: 'a' }), false);
  assert.equal(canDrop(folders, { folderId: 'x' }, { kind: 'folder', folderId: 'a' }), true);
  assert.equal(canDrop(folders, { folderId: 'a' }, { kind: 'root' }), true);
  assert.equal(canDrop(folders, {}, { kind: 'folder', folderId: 'c' }), true); // a chat can go anywhere
  const deep = [F('1', null), F('2', '1'), F('3', '2'), F('4', '3'), F('5', '4'), F('s', null), F('s2', 's')];
  assert.equal(canDrop(deep, { folderId: 's' }, { kind: 'folder', folderId: '4' }), false); // 4 + 2 levels = 6
  assert.equal(canDrop(deep, { folderId: 's2' }, { kind: 'folder', folderId: '4' }), true);
});

test('drop zones, positions and insertion', () => {
  assert.deepEqual([zoneOf('folder', 0.1), zoneOf('folder', 0.5), zoneOf('folder', 0.9), zoneOf('chat', 0.4), zoneOf('chat', 0.6), zoneOf('project', 0.1), zoneOf('root', 0.9)], ['before', 'inside', 'after', 'before', 'after', 'inside', 'inside']);
  assert.deepEqual([between(1, 3), between(2, undefined), between(undefined, 2), between()], [2, 3, 1, 1]);
  const l = [{ id: '1' }, { id: '2' }, { id: '3' }];
  assert.deepEqual(insertAround(l, { id: '3' }, '1', 'before').map((x) => x.id), ['3', '1', '2']);
  assert.deepEqual(insertAround(l, { id: '1' }, '3', 'after').map((x) => x.id), ['2', '3', '1']);
  assert.deepEqual(insertAround(l, { id: '9' }, undefined, 'after').map((x) => x.id), ['1', '2', '3', '9']);
});
