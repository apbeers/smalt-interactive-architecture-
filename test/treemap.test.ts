import { test } from 'node:test';
import assert from 'node:assert/strict';
import { treemap } from '../src/site/engine3d.js';

test('treemap cells fill the rectangle in proportion, without overlap', () => {
  const weights = [50, 20, 10, 10, 5, 3, 1, 1];
  const cells = treemap(weights.map((w, i) => ({ item: i, weight: w })), 0, 0, 100, 60);
  assert.equal(cells.length, weights.length);
  const total = weights.reduce((a, b) => a + b, 0);
  for (const c of cells) {
    assert.ok(Math.abs((c.w * c.h) / (100 * 60) - weights[c.item]! / total) < 1e-9, 'area in proportion');
    assert.ok(c.x >= -1e-9 && c.y >= -1e-9 && c.x + c.w <= 100 + 1e-9 && c.y + c.h <= 60 + 1e-9, 'inside');
  }
  for (const a of cells) for (const b of cells) {
    if (a === b) continue;
    const overlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;
    assert.ok(!overlap, `${a.item} overlaps ${b.item}`);
  }
  assert.deepEqual(treemap([{ item: 'x', weight: 0 }], 0, 0, 10, 10), []);
});
