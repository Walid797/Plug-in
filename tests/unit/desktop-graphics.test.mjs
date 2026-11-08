import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { needsSoftwareGraphics, useSoftwareGraphics } = require('../../desktop/graphics.cjs');

test('a Windows PC without a real graphics card is detected', () => {
  const warp = { gpuDevice: [{ active: true, vendorId: 0x1414, deviceId: 0x8c }] };
  assert.equal(needsSoftwareGraphics(warp, 'win32'), true, 'Microsoft Basic Render Driver');
  assert.equal(needsSoftwareGraphics({ gpuDevice: [] }, 'win32'), true, 'no device at all');
  assert.equal(needsSoftwareGraphics(null, 'win32'), true, 'no info');
  assert.equal(needsSoftwareGraphics({ gpuDevice: [{ active: true, vendorId: 0x8086, deviceId: 0x3e92 }] }, 'win32'), false, 'Intel GPU');
  assert.equal(needsSoftwareGraphics({ gpuDevice: [{ active: false, vendorId: 0x1414 }, { active: true, vendorId: 0x10de }] }, 'win32'), false, 'NVIDIA active');
  assert.equal(needsSoftwareGraphics({ gpuDevice: [] }, 'linux'), false, 'only Windows is switched automatically');
});

test('the graphics choice follows the settings, then the remembered detection', () => {
  assert.equal(useSoftwareGraphics({}, {}), false);
  assert.equal(useSoftwareGraphics({}, { softwareGraphics: true }), true);
  assert.equal(useSoftwareGraphics({ graphics: 'hardware' }, { softwareGraphics: true }), false);
  assert.equal(useSoftwareGraphics({ graphics: 'software' }, {}), true);
  assert.equal(useSoftwareGraphics({ graphics: 'auto' }, { softwareGraphics: true }), true);
});
