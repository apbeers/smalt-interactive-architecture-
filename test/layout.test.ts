import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgePath, layout, rankNodes } from '../src/site/layout.js';

test('ranks put what depends above what it depends on', () => {
  const r = rankNodes(['app', 'kit', 'db'], [{ from: 'app', to: 'kit' }, { from: 'kit', to: 'db' }, { from: 'app', to: 'db' }]);
  assert.deepEqual([r.get('app'), r.get('kit'), r.get('db')], [0, 1, 2]);
});

test('cycles are broken, not looped on', () => {
  const r = rankNodes(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
  assert.equal(r.size, 3);
  assert.ok([...r.values()].every((v) => Number.isFinite(v)));
});

test('nodes do not overlap and keep fixed ranks', () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, width: 100 + (i % 3) * 20, height: 40, rank: i % 3 }));
  const edges = nodes.slice(1).map((n, i) => ({ from: nodes[i]!.id, to: n.id }));
  const lay = layout(nodes, edges, { maxPerRow: 6 });
  const placed = [...lay.nodes.values()];
  assert.equal(placed.length, 30);
  for (const a of placed) {
    assert.equal(a.rank, Number(a.id.slice(1)) % 3);
    for (const b of placed) {
      if (a === b) continue;
      const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
      assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
    }
  }
  assert.match(edgePath(placed[0]!, placed[1]!), /^M[\d.]+,[\d.]+ C/);
});
