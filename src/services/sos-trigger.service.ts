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

function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const n = Math.floor(Math.random() * 16);
    return (c === 'x' ? n : (n & 3) | 8).toString(16);
  });
}

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
  public static getDeviceId(): Promise<string> {
    return this.exclusive(async () => {
      let id = await AsyncStorage.getItem(DEVICE_KEY);
      if (!id) { id = uuid(); await AsyncStorage.setItem(DEVICE_KEY, id); }
      return id;
    });
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
    return this.exclusive(async () => {
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      queue.push(payload);
      await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      try {
        const { isOnline } = await NetworkService.checkConnectivity();
        if (isOnline) {
          await SOSApiService.sendSOS({ ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE });
          await this.remove(payload.sosId);
          return { ...payload, deliveryMethod: DeliveryMethod.DIRECT_ONLINE };
        }
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) {
          // Invalid credentials/validation must not become anonymous mesh submissions.
          throw new Error(`${error.message}. Alert retained locally for retry after correction.`);
        }
      }
      try {
        await bleMeshInstance.startAdvertising({ ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY });
        return { ...payload, deliveryMethod: DeliveryMethod.BLE_RELAY };
      } catch { return payload; } // Durable queue exists; never report server delivery.
    });
  }
  public static cancelSOS(sosId: string, userId: string, reason?: string, authToken?: string): Promise<boolean> {
    if (authToken) SOSApiService.setAuthToken(authToken);
    return this.exclusive(async () => {
      const cancellation: SOSCancellation = { sosId, userId, reason, cancelledAt: new Date().toISOString() };
      const pending = await this.read<SOSCancellation>(CANCEL_KEY);
      // Persist cancellation first so a crash cannot re-send the original alert.
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify([...pending.filter(item => item.sosId !== sosId), cancellation]));
      await this.remove(sosId);
      await bleMeshInstance.stopAdvertising(sosId).catch(() => undefined);
      try {
        await SOSApiService.cancelSOS(cancellation);
        await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(pending.filter(item => item.sosId !== sosId)));
        return true;
      } catch { return false; }
    });
  }
  public static retryPendingQueue(): Promise<void> {
    return this.exclusive(async () => {
      const { isOnline } = await NetworkService.checkConnectivity();
      if (!isOnline) return;
      const cancellations = await this.read<SOSCancellation>(CANCEL_KEY);
      const cancelledIds = new Set(cancellations.map(item => item.sosId));
      const remainingCancellations = [];
      for (const cancellation of cancellations) {
        await this.remove(cancellation.sosId);
        try { await SOSApiService.cancelSOS(cancellation); }
        catch { remainingCancellations.push(cancellation); }
      }
      await AsyncStorage.setItem(CANCEL_KEY, JSON.stringify(remainingCancellations));
      const queue = await this.read<SOSPayload>(QUEUE_KEY);
      for (const payload of queue) {
        if (cancelledIds.has(payload.sosId) || !isLivePayload(payload)) {
          await this.remove(payload.sosId);
          await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
          continue;
        }
        // Older app versions persisted tokens: do not reuse them.
        try {
          await SOSApiService.sendSOS({ ...payload, authToken: undefined, deliveryMethod: DeliveryMethod.OFFLINE_QUEUED });
          await this.remove(payload.sosId);
          await bleMeshInstance.stopAdvertising(payload.sosId).catch(() => undefined);
        } catch { /* Keep undelivered alerts for the next retry. */ }
      }
    });
  }
  private static async remove(sosId: string): Promise<void> {
    const queue = await this.read<SOSPayload>(QUEUE_KEY);
    await AsyncStorage.setItem(QUEUE_KEY, JSON.stringify(queue.filter(item => item.sosId !== sosId).map(item => ({ ...item, authToken: undefined }))));
  }
}
