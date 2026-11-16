import { test } from 'node:test';
import assert from 'node:assert/strict';
import { View3D } from '../src/site/engine3d.js';

/** A View3D's projection without a canvas. */
function view(yaw: number, pitch: number): View3D {
  const v = Object.create(View3D.prototype) as View3D;
  v.cam = { target: { x: 0, y: 0, z: 0 }, yaw, pitch, dist: 100 };
  v.W = 800;
  v.H = 600;
  (v as unknown as { focal: number }).focal = 500;
  return v;
}

test('the camera looks down from above: higher points are nearer and higher on screen', () => {
  for (const yaw of [0, 0.7, -2, 3]) {
    for (const pitch of [0.1, 0.6, 1.4]) {
      const v = view(yaw, pitch);
      const base = v.project({ x: 0, y: 0, z: 0 });
      const top = v.project({ x: 0, y: 10, z: 0 });
      assert.ok(top.depth < base.depth, `top nearer (yaw ${yaw}, pitch ${pitch})`);
      assert.ok(top.sy < base.sy, `top higher on screen (yaw ${yaw}, pitch ${pitch})`);
    }
  }
});

test('ground toward the camera is nearer and lower on screen', () => {
  const v = view(0, 0.6);
  const far = v.project({ x: 0, y: 0, z: 20 });
  const near = v.project({ x: 0, y: 0, z: -20 });
  assert.ok(near.depth < far.depth);
  assert.ok(near.sy > far.sy);
  // A building's top looks wider than its base: perspective from above.
  const topW = v.project({ x: 5, y: 10, z: 0 }).sx - v.project({ x: -5, y: 10, z: 0 }).sx;
  const baseW = v.project({ x: 5, y: 0, z: 0 }).sx - v.project({ x: -5, y: 0, z: 0 }).sx;
  assert.ok(topW > baseW);
});
