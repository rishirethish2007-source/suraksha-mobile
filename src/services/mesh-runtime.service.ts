/** One app-level runtime; independent of mounted screens, also used by Headless JS. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as BackgroundTask from 'expo-background-task';
import * as Peripheral from '../../modules/ble-peripheral';
import { Platform } from 'react-native';
import { decodePayload, isLivePayload } from './ble-codec';
import { verifyOrigin } from './origin-security';
import { bleMeshInstance, SOSTriggerService } from './sos-trigger.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { loadSession } from './session.service';
import { NetworkService } from './network.service';
import { ActiveSOSEvent, SOSPayload, SOSLocation } from '../interfaces/sos.types';

export const RETRY_TASK = 'suraksha-sos-retry-v2';
const RELAYS = '@suraksha.relay.pending.v2';
const NEARBY = '@suraksha.nearby.v2';
const ENABLED = '@suraksha.relay.enabled.v2';
let operations: Promise<unknown> = Promise.resolve();
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work, work); operations = next.catch(() => undefined); return next;
}
async function list<T>(key: string): Promise<T[]> {
  const value = await AsyncStorage.getItem(key);
  return value ? JSON.parse(value) : [];
}
export async function nearbyEvents(): Promise<ActiveSOSEvent[]> {
  return (await list<ActiveSOSEvent>(NEARBY)).filter(isLivePayload);
}
async function location(): Promise<SOSLocation | undefined> {
  try {
    const fix = await Location.getLastKnownPositionAsync({ maxAge: 600000, requiredAccuracy: 1000 });
    if (fix) return { latitude: fix.coords.latitude, longitude: fix.coords.longitude, accuracy: fix.coords.accuracy ?? 1000, provider: 'last_known' };
  } catch { /* Background code never opens a permission prompt. */ }
}
async function notify(event: ActiveSOSEvent) {
  if (Platform.OS === 'web') return;
  const distance = event.distanceMeters === undefined ? 'Distance unavailable' : `${Math.round(event.distanceMeters)} m away`;
  await Notifications.scheduleNotificationAsync({ content: { title: `Nearby ${event.sosType} SOS`,
    body: `${event.userName}: ${distance}. Open Suraksha to view location and offer help.`,
    sound: 'default', data: { sosId: event.sosId }, categoryIdentifier: 'SOS_HELP' }, trigger: null });
}
export function processMeshWork(): Promise<void> {
  return serial(async () => {
    const session = await loadSession();
    if (!session) return;
    const deviceId = await SOSTriggerService.getDeviceId();
    const selfLocation = await location();
    let events = await nearbyEvents();
    let pending = (await list<SOSPayload>(RELAYS)).filter(isLivePayload);
    for (const packet of await Peripheral.getInbox()) {
      let payload: SOSPayload;
      try { payload = decodePayload(packet); await verifyOrigin(payload); }
      catch { await Peripheral.acknowledgeInbox(packet); continue; }
      if (payload.originDeviceId === deviceId || payload.relayChain.some(node => node.deviceId === deviceId)) {
        await Peripheral.acknowledgeInbox(packet); continue;
      }
      if (!events.some(event => event.sosId === payload.sosId)) {
        const distanceMeters = selfLocation ? bleMeshInstance.calculateDistance(selfLocation.latitude, selfLocation.longitude,
          payload.location.latitude, payload.location.longitude) : undefined;
        const event = { ...payload, distanceMeters };
        events = [...events.slice(-199), event];
        await AsyncStorage.setItem(NEARBY, JSON.stringify(events));
        bleMeshInstance.reportReceived(event);
        await notify(event).catch(() => undefined); // Denied notifications must not block emergency forwarding.
      }
      if (payload.hopCount < payload.maxHops && !pending.some(item => item.sosId === payload.sosId)) {
        pending.push(bleMeshInstance.prepareRelay(payload, deviceId, selfLocation));
        await AsyncStorage.setItem(RELAYS, JSON.stringify(pending));
      }
      // Acknowledge only after the forwarding queue is durable.
      await Peripheral.acknowledgeInbox(packet);
    }
    const { isOnline } = await NetworkService.checkConnectivity().catch(() => ({ isOnline: false }));
    const remaining: SOSPayload[] = [];
    for (const payload of pending) {
      let delivered = false;
      if (isOnline) {
        try { await SOSApiService.sendSOS(payload); delivered = true; } catch (error) { if (error instanceof ApiError && error.status === 410) delivered = true; /* Cancelled events must not be rebroadcast. */ }
      }
      if (delivered) await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
      if (!delivered) {
        remaining.push(payload);
        await bleMeshInstance.startAdvertising(payload).catch(() => undefined);
      }
    }
    await AsyncStorage.setItem(RELAYS, JSON.stringify(remaining));
    await SOSTriggerService.retryPendingQueue();
  });
}
export async function setRelayEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    if (!(await loadSession())) throw new Error('Sign in and enroll this device before enabling relay.');
    await bleMeshInstance.requestPermissions();
    const permission = await Location.requestForegroundPermissionsAsync();
    if (permission.granted) await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => undefined);
    if (Platform.OS !== 'web') {
      if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('sos-alerts', { name: 'Nearby SOS alerts', importance: Notifications.AndroidImportance.HIGH });
      await Notifications.requestPermissionsAsync();
      await Notifications.setNotificationCategoryAsync('SOS_HELP', [{ identifier: 'OPEN_SOS', buttonTitle: 'View and help', options: { opensAppToForeground: true } }]);
    }
    await bleMeshInstance.startScanning();
  } else { await bleMeshInstance.stopScanning(); }
  await AsyncStorage.setItem(ENABLED, String(enabled));
}
export async function isRelayEnabled(): Promise<boolean> { return await AsyncStorage.getItem(ENABLED) === 'true'; }
export async function startMeshRuntime(): Promise<void> {
  if (unsubscribe) return;
  const work = () => { void processMeshWork().catch(error => console.warn('SOS work deferred', error instanceof Error ? error.message : 'unknown')); };
  bleMeshInstance.on('onInboxReady', work);
  const stopNetwork = NetworkService.subscribe(online => { if (online) work(); });
  timer = setInterval(work, 30000);
  unsubscribe = () => { stopNetwork(); bleMeshInstance.off('onInboxReady', work); if (timer) clearInterval(timer); unsubscribe = undefined; };
  if (Platform.OS !== 'web') {
    if (await isRelayEnabled()) await bleMeshInstance.startScanning().catch(() => undefined);
    if (await BackgroundTask.getStatusAsync() === BackgroundTask.BackgroundTaskStatus.Available) {
      await BackgroundTask.registerTaskAsync(RETRY_TASK, { minimumInterval: 15 });
    }
  }
  work();
}
export function stopMeshRuntime() { unsubscribe?.(); }
