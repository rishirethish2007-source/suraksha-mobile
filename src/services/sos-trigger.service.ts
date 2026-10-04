import { signOrigin } from './origin-security';
import * as Crypto from 'expo-crypto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LocationService } from './location.service';
import { NetworkService } from './network.service';
import { SOSApiService, ApiError } from './sos-api.service';
import { BLEMeshService } from './ble-mesh.service';
import { SOSPayload, SOSType, SOSStatus, DeliveryMethod, SOSMessageType, SOSCancellation } from '../interfaces/sos.types';
import { isLivePayload } from './ble-codec';
import { SOS_TTL_SECONDS, MAX_HOP_COUNT } from '../constants/ble.constants';

const QUEUE_KEY = '@suraksha_sos_queue';
const CANCEL_KEY = '@suraksha_sos_cancellations';
const DEVICE_KEY = '@suraksha_device_id';
export const bleMeshInstance = new BLEMeshService();

function uuid(): string { return Crypto.randomUUID(); }

export class SOSTriggerService {
  // Serialize read-modify-write operations and network retries to prevent lost updates.
  private static operations: Promise<unknown> = Promise.resolve();
  private static exclusive<T>(action: () => Promise<T>): Promise<T> {
    const next = this.operations.then(action, action);
    this.operations = next.catch(() => undefined);
    return next;
  }
  private static async read<T>(key: string): Promise<T[]> {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Stored SOS queue is invalid; it has been preserved.');
    return parsed as T[];
  }
  private static deviceIdPromise: Promise<string> | undefined;
  public static getDeviceId(): Promise<string> {
    if (this.deviceIdPromise) return this.deviceIdPromise;
    this.deviceIdPromise = (async () => {
      let id = await AsyncStorage.getItem(DEVICE_KEY);
      if (!id) { id = uuid(); await AsyncStorage.setItem(DEVICE_KEY, id); }
      return id;
    })().catch(error => { this.deviceIdPromise = undefined; throw error; });
    return this.deviceIdPromise;
  }
  public static async triggerSOS(params: { userId: string; userName: string; userPhone: string;
    authToken?: string; sosType: SOSType; message?: string }): Promise<SOSPayload> {
    if (!params.userId.trim() || !params.userName.trim()) throw new Error('Enter your user ID and name before sending an SOS.');
    if (params.authToken) SOSApiService.setAuthToken(params.authToken);
    const location = await LocationService.getCurrentLocation();
    const originDeviceId = await this.getDeviceId();
    const timestamp = new Date().toISOString();
    const payload: SOSPayload = { sosId: uuid(), userId: params.userId.trim(), userName: params.userName.trim(),
      userPhone: params.userPhone.trim(), sosType: params.sosType, messageType: SOSMessageType.SOS_ALERT,
      location, timestamp, createdAt: timestamp, originDeviceId, hopCount: 0, maxHops: MAX_HOP_COUNT,
      relayChain: [], deliveryMethod: DeliveryMethod.OFFLINE_QUEUED, status: SOSStatus.ACTIVE,
      message: params.message, ttlSeconds: SOS_TTL_SECONDS };
    payload.originProof = await signOrigin(payload);
    await this.exclusive(async () => {
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      queue.push(payload);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    });
      // Start local discovery immediately, including when the backend is online.
      // Upload success does not retract the nearby alert; cancellation/TTL does.
      let broadcasting = false;
      try {
        await bleMeshInstance.requestPermissions();
        await bleMeshInstance.startAdvertising({ ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY });
        broadcasting = true;
      } catch { /* Online delivery still works without Bluetooth. */ }
      try {
        const { isOnline } = await NetworkService.checkConnectivity();
        if (isOnline) {
          await SOSApiService.sendSOS({ ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE });
          await this.exclusive(() => this.remove(payload.sosId));
          return { ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE };
        }
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          // Stop this advert if the server explicitly rejects the submission.
          await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
          throw new Error(`${error.message}. Alert retained locally for retry after correction.`);
        }
      }
      return broadcasting ? { ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY } : payload;

  }
  public static async cancelSOS(sosId: string, userId: string, reason?: string, authToken?: string): Promise<boolean> {
    if (authToken) SOSApiService.setAuthToken(authToken);
    const cancellation: SOSCancellation = { sosId, userId, reason, cancelledAt: new Date().toISOString() };
    await this.exclusive(async () => {
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      // Persist first. Queue uploads check this tombstone before every send.
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify([...pending.filter(item => item.sosId !== sosId), cancellation]));
      await this.remove(sosId);
    });
    await bleMeshInstance.stopAdvertising(sosId).catch(() => undefined);
    try {
      await SOSApiService.cancelSOS(cancellation);
      await this.exclusive(async () => {
        const latest = await this.read<SOSCancellation>(CANCEL_KEY);
        await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(latest.filter(item => item.sosId !== sosId)));
      });
      return true;
    } catch { return false; }
  }
  private static retrying: Promise<void> | undefined;
  public static retryPendingQueue(): Promise<void> {
    if (!this.retrying) this.retrying = this.flushQueue().finally(() => { this.retrying = undefined; });
    return this.retrying;
  }
  private static async flushQueue(): Promise<void> {
    const { isOnline } = await NetworkService.checkConnectivity();
    const cancellations = await this.exclusive(() => this.read<SOSCancellation>(CANCEL_KEY));
    for (const cancellation of cancellations) {
      await this.exclusive(() => this.remove(cancellation.sosId));
      await bleMeshInstance.stopAdvertising(cancellation.sosId).catch(() => undefined);
      if (isOnline) {
        try {
          await SOSApiService.cancelSOS(cancellation);
          await this.exclusive(async () => {
            const latest = await this.read<SOSCancellation>(CANCEL_KEY);
            await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(latest.filter(item => item.sosId !== cancellation.sosId)));
          });
        } catch { /* Keep the durable cancellation. */ }
      }
    }
    const queue = await this.exclusive(() => this.read<SOSPayload>(QUEUE_KEY));
    for (const payload of queue) {
      // Re-read, because cancellation can happen while another upload is pending.
      const stillQueued = await this.exclusive(async () =>
        (await this.read<SOSPayload>(QUEUE_KEY)).some(item => item.sosId === payload.sosId) &&
        !(await this.read<SOSCancellation>(CANCEL_KEY)).some(item => item.sosId === payload.sosId));
      if (!stillQueued) continue;
      if (!isLivePayload(payload)) {
        await this.exclusive(() => this.remove(payload.sosId));
        await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
        continue;
      }
      if (isOnline) {
        try {
          await SOSApiService.sendSOS({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.OFFLINE_QUEUED });
          await this.exclusive(() => this.remove(payload.sosId));
          continue;
        } catch { /* Keep undelivered alerts for the next retry. */ }
      }
      // Serialize the final presence check and advertise against local cancellation.
      await this.exclusive(async () => {
        if ((await this.read<SOSPayload>(QUEUE_KEY)).some(item => item.sosId === payload.sosId))
          await bleMeshInstance.startAdvertising({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.BLE_RELAY }).catch(() => undefined);
      });
    }
  }
  private static async remove(sosId: string): Promise<void> {
    const queue = await this.read<SOSPayload>(QUEUE_KEY);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter(item => item.sosId !== sosId).map(item => ({ ...item, authToken: undefined }))));
  }
}
