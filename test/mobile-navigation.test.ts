import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchAndroidBack, installBackButtonListener } from '../apps/mobile/src/platform/android-back.ts';

test('Android Back subscriptions clean up after asynchronous registration and ignore stale events', async () => {
  let listener = () => {};
  let finishRegistration!: (handle: { remove(): Promise<void> }) => void;
  let backs = 0, removals = 0;
  const errors: unknown[] = [];
  const dispose = installBackButtonListener((onBack) => {
    listener = onBack;
    return new Promise((resolve) => { finishRegistration = resolve; });
  }, () => { backs++; }, (error) => errors.push(error));
  listener();
  assert.equal(backs, 1);
  dispose(); dispose();
  listener();
  assert.equal(backs, 1);
  finishRegistration({ remove: async () => { removals++; } });
  await Promise.resolve(); await Promise.resolve();
  assert.equal(removals, 1);
  assert.deepEqual(errors, []);
});

test('Android Back subscriptions remove an established listener only once', async () => {
  let removals = 0;
  const dispose = installBackButtonListener(async () => ({ remove: async () => { removals++; } }), () => {});
  await Promise.resolve();
  dispose(); dispose();
  await Promise.resolve();
  assert.equal(removals, 1);
});

test('an overlay consumes Android Back before page navigation', () => {
  const target = new EventTarget();
  let backs = 0;
  target.addEventListener('hpb:back', (event) => event.preventDefault(), { once: true });
  dispatchAndroidBack(target, () => { backs++; });
  assert.equal(backs, 0);
  dispatchAndroidBack(target, () => { backs++; });
  assert.equal(backs, 1);
});
