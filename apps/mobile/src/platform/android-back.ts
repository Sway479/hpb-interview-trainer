import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { HpbNative } from './native-bridge.js';

type BackRegistration = (listener: () => void) => Promise<PluginListenerHandle>;

/** Keep asynchronous native registration safe across unmounts and React StrictMode. */
export function installBackButtonListener(
  register: BackRegistration,
  onBack: () => void,
  onError: (error: unknown) => void = () => {},
): () => void {
  let active = true;
  let handle: PluginListenerHandle | undefined;
  const remove = (listener: PluginListenerHandle) => { void listener.remove().catch(onError); };
  void register(() => { if (active) onBack(); }).then((listener) => {
    if (active) handle = listener;
    else remove(listener);
  }, (error) => { if (active) onError(error); });
  return () => {
    if (!active) return;
    active = false;
    if (handle) { remove(handle); handle = undefined; }
  };
}

/** Local overlays can prevent this event before the current page handles Back. */
export function dispatchAndroidBack(target: EventTarget, onBack: () => void): void {
  if (target.dispatchEvent(new Event('hpb:back', { cancelable: true }))) onBack();
}

export function listenForAndroidBackButton(
  onBack: () => void,
  onError?: (error: unknown) => void,
): () => void {
  if (Capacitor.getPlatform() !== 'android') return () => {};
  return installBackButtonListener(
    (listener) => HpbNative.addListener('backButton', listener),
    () => dispatchAndroidBack(window, onBack),
    onError,
  );
}
