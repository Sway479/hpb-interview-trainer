// Tool lookup for optional QA scripts. Does not read provider credentials.
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

function playwright() {
  if (process.env.PLAYWRIGHT_MODULE) return require(process.env.PLAYWRIGHT_MODULE);
  try { return require('playwright'); } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
  }
  const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
  if (existsSync(bundled)) return require(bundled);
  throw new Error('Playwright is optional QA tooling. Set PLAYWRIGHT_MODULE to its absolute module directory; see docs/MACOS_DEVELOPMENT.md.');
}

function adbPath() {
  if (process.env.HPB_ADB) return process.env.HPB_ADB;
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
    (process.platform === 'darwin' ? join(homedir(), 'Library/Android/sdk') :
      process.platform === 'win32' ? 'E:/Android' : join(homedir(), 'Android/Sdk'));
  return join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
}

function pythonCommand() {
  if (process.env.HPB_PYTHON) return process.env.HPB_PYTHON;
  const bundled = join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe');
  return process.platform === 'win32' && existsSync(bundled) ? bundled : 'python3';
}

function browserExecutable() {
  if (process.env.HPB_BROWSER_EXECUTABLE) return process.env.HPB_BROWSER_EXECUTABLE;
  const candidates = process.platform === 'darwin' ? [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ] : process.platform === 'win32' ? [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ] : [];
  return candidates.find(path => existsSync(path)); // undefined lets Playwright use its own Chromium.
}

module.exports = { playwright, adbPath, pythonCommand, browserExecutable };
