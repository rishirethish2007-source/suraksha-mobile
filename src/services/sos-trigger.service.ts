/**
 * @fileoverview Orchestrator for SOS operations handling generation, networking, and mesh fallback.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { LocationService } from './location.service';
import { NetworkService } from './network.service';
import { SOSApiService } from './sos-api.service';
import { BLEMeshService } from './ble-mesh.service';
import {
  SOSPayload,
  SOSType,
  SOSStatus,
  DeliveryMethod,
  SOSMessageType,
  SOSCancellation
} from '../interfaces/sos.types';
import { SOS_TTL_SECONDS, MAX_HOP_COUNT } from '../constants/ble.constants';

const SOS_QUEUE_KEY = '@suraksha_sos_queue';

// Generate UUID v4
function uuidv4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// Global shared instance for background hooks
export const bleMeshInstance = new BLEMeshService();
bleMeshInstance.initialize();

export class SOSTriggerService {
  /**
   * Trigger an SOS alert.
   * Acquires location, checks network, and dispatches via API or BLE mesh.
   */
  public static async triggerSOS(params: {
    userId: string;
    userName: string;
    userPhone: string;
    authToken?: string;
    sosType: SOSType;
    message?: string;
  }): Promise<SOSPayload> {
    const sosId = uuidv4();
    const originDeviceId = `device_${params.userId}_${Math.random().toString(36).substring(7)}`;
    const timestamp = new Date().toISOString();

    let location;
    try {
      location = await LocationService.getCurrentLocation();
    } catch (err) {
      // Fallback location if absolutely unable to obtain
      location = { latitude: 0, longitude: 0, accuracy: 9999, provider: 'last_known' as const };
    }

    const payload: SOSPayload = {
      sosId,
      messageType: SOSMessageType.SOS_ALERT,
      userId: params.userId,
      userName: params.userName,
      userPhone: params.userPhone,
      authToken: params.authToken,
      sosType: params.sosType,
      location,
      timestamp,
      originDeviceId,
      hopCount: 0,
      maxHops: MAX_HOP_COUNT,
      relayChain: [],
      deliveryMethod: DeliveryMethod.OFFLINE_QUEUED, // Default assumption
      status: SOSStatus.ACTIVE,
      message: params.message,
      ttlSeconds: SOS_TTL_SECONDS,
      createdAt: timestamp,
    };

    // Store in retry queue
    await this.queuePayload(payload);

    const { isOnline } = await NetworkService.checkConnectivity();

    if (isOnline) {
      try {
        await SOSApiService.sendSOS(payload);
        payload.deliveryMethod = DeliveryMethod.DIRECT_ONLINE;
        await this.removeFromQueue(sosId);
      } catch (err) {
        console.warn('API failed, falling back to offline mesh', err);
        payload.deliveryMethod = DeliveryMethod.BLE_RELAY;
        await bleMeshInstance.startAdvertising(payload);
      }
    } else {
      payload.deliveryMethod = DeliveryMethod.BLE_RELAY;
      await bleMeshInstance.startAdvertising(payload);
    }

    return payload;
  }

  /**
   * Cancel an active SOS alert.
   */
  public static async cancelSOS(sosId: string, userId: string, reason?: string, authToken?: string): Promise<void> {
    const cancellation: SOSCancellation = {
      sosId,
      userId,
      cancelledAt: new Date().toISOString(),
      reason
    };

    const { isOnline } = await NetworkService.checkConnectivity();

    // Broadcast cancellation to local mesh regardless of connection
    await bleMeshInstance.broadcastCancellation(cancellation);
    
    // Stop advertising the original SOS payload
    await bleMeshInstance.stopAdvertising();
    await this.removeFromQueue(sosId);

    if (isOnline) {
      try {
        await SOSApiService.cancelSOS(cancellation, authToken);
      } catch (err) {
        console.error('Failed to send cancellation to server', err);
      }
    }
  }

  /**
   * Retry pending offline SOS queues when network is restored.
   */
  public static async retryPendingQueue(): Promise<void> {
    const queue = await this.getQueue();
    if (queue.length === 0) return;

    const { isOnline } = await NetworkService.checkConnectivity();
    if (!isOnline) return;

    for (const payload of queue) {
      try {
        await SOSApiService.sendSOS(payload);
        await this.removeFromQueue(payload.sosId);
      } catch (err) {
        console.error('Failed to retry payload', err);
      }
    }
  }

  private static async getQueue(): Promise<SOSPayload[]> {
    const data = await AsyncStorage.getItem(SOS_QUEUE_KEY);
    return data ? JSON.parse(data) : [];
  }

  private static async queuePayload(payload: SOSPayload): Promise<void> {
    const queue = await this.getQueue();
    queue.push(payload);
    await AsyncStorage.setItem(SOS_QUEUE_KEY, JSON.stringify(queue));
  }

  private static async removeFromQueue(sosId: string): Promise<void> {
    const queue = await this.getQueue();
    const newQueue = queue.filter(p => p.sosId !== sosId);
    await AsyncStorage.setItem(SOS_QUEUE_KEY, JSON.stringify(newQueue));
  }
}
