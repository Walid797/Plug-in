'use strict';
// Choosing the graphics engine for WebGL (the AI models need WebGL even on their CPU path). Pure functions, unit-tested.
//
// On a Windows PC without a graphics card Chromium may pick "Microsoft Basic Render Driver" (WARP, vendor 0x1414) or
// no device at all. There the AI model stayed "loading" forever. SwiftShader (Chromium's own software WebGL, tested:
// the whole one-click pipeline takes about 6 s on one CPU core) is used instead.

const MICROSOFT_VENDOR = 0x1414; // Microsoft Basic Render Driver / WARP / Basic Display Adapter

/** Does the basic GPU info (app.getGPUInfo('basic')) show that no real graphics card is in use? */
function needsSoftwareGraphics(info, platform = process.platform) {
  if (platform !== 'win32') return false;
  const devices = (info && Array.isArray(info.gpuDevice)) ? info.gpuDevice : [];
  if (!devices.length) return true;
  const active = devices.find((d) => d.active) || devices[0];
  return active.vendorId === MICROSOFT_VENDOR;
}

/**
 * Should this start use SwiftShader?  settings.graphics: "auto" (default) | "software" | "hardware".
 * In "auto", a previous start that found no real graphics card is remembered in state.softwareGraphics.
 */
function useSoftwareGraphics(settings = {}, state = {}) {
  if (settings.graphics === 'software') return true;
  if (settings.graphics === 'hardware') return false;
  return state.softwareGraphics === true;
}

module.exports = { needsSoftwareGraphics, useSoftwareGraphics, MICROSOFT_VENDOR };
