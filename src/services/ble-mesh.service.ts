/**
 * @fileoverview BLE Mesh Service handling discovery and GATT payload transfer.
 * 
 * WHY HYBRID DISCOVERY + GATT?
 * Standard BLE advertisements are severely limited in size (typically ~31 bytes).
 * Our SOS payload is comprehensive (location, timestamps, relay chains, etc) and can exceed 512 bytes.
 * Thus, we advertise only a short Service UUID + a brief deduplication ID. 
 * Devices scanning for this Service UUID connect briefly as a GATT Central, 
 * read the full characteristic (up to 512 bytes MTU), validate it, and disconnect immediately.
 *
 * ASYMMETRIC DISCOVERY & OS LIMITATIONS
 * - iOS: Background scanning is restricted. Interval slows to minutes, and custom Service UUIDs are required.
 * - Android: Requires Foreground Services with persistent notification for background BLE ops.
 */

import { BleManager, Device, Characteristic } from 'react-native-ble-plx';
import { Buffer } from 'buffer';
import { EventEmitter } from 'events';
import { 
  SOSPayload, 
  SOSCancellation, 
  SOSLocation 
} from '../interfaces/sos.types';
import {
  SURAKSHA_SERVICE_UUID,
  SURAKSHA_SOS_CHARACTERISTIC_UUID,
  SURAKSHA_CANCEL_CHARACTERISTIC_UUID,
  MAX_HOP_COUNT,
  BLE_SCAN_INTERVAL_MS,
  BLE_RELAY_JITTER_MIN_MS,
  BLE_RELAY_JITTER_MAX_MS,
  DEDUP_CACHE_SIZE
} from '../constants/ble.constants';

// Simulated Native Bridge for Peripheral Mode (Advertising & GATT Server)
// (Since react-native-ble-plx does not support Peripheral mode natively)
const NativePeripheralBridge = {
  startAdvertising: async (serviceUUID: string, characteristicUUID: string, payloadBase64: string) => {
    console.log(`[Native Bridge] Started advertising ${serviceUUID} with payload size: ${payloadBase64.length}`);
  },
  stopAdvertising: async () => {
    console.log('[Native Bridge] Stopped advertising');
  }
};

export class BLEMeshService extends EventEmitter {
  private manager: BleManager | null = null;
  private isScanning: boolean = false;
  private isAdvertising: boolean = false;
  private dedupCache: Set<string>;
  
  constructor() {
    super();
    this.dedupCache = new Set();
    
    // Safely initialize BleManager (prevents crash in Expo Go where native module is missing)
    try {
      this.manager = new BleManager();
    } catch (e) {
      console.warn("BLE Native Module not found. Running in mock mode for Expo Go.");
    }
  }

  /**
   * Initializes the BLE manager and requests permissions.
   */
  public async initialize(): Promise<void> {
    if (!this.manager) return;
    const state = await this.manager.state();
    if (state !== 'PoweredOn') {
      console.warn('Bluetooth is not powered on');
      // In a real implementation, request user to turn on Bluetooth
    }
  }

  /**
   * Calculates CRC32 checksum for payload integrity.
   * Simplified mock implementation.
   */
  private calculateChecksum(data: string): string {
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const char = data.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  /**
   * Starts peripheral mode advertising.
   */
  public async startAdvertising(payload: SOSPayload): Promise<void> {
    if (this.isAdvertising) return;

    try {
      const payloadStr = JSON.stringify(payload);
      const checksum = this.calculateChecksum(payloadStr);
      
      const gattPayload = { payload, checksum };
      const base64Data = Buffer.from(JSON.stringify(gattPayload), 'utf-8').toString('base64');
      
      await NativePeripheralBridge.startAdvertising(
        SURAKSHA_SERVICE_UUID,
        SURAKSHA_SOS_CHARACTERISTIC_UUID,
        base64Data
      );
      this.isAdvertising = true;
    } catch (err) {
      this.emit('onError', err);
    }
  }

  /**
   * Stops peripheral mode advertising.
   */
  public async stopAdvertising(): Promise<void> {
    if (!this.isAdvertising) return;
    await NativePeripheralBridge.stopAdvertising();
    this.isAdvertising = false;
  }

  /**
   * Manages LRU deduplication cache.
   */
  private addToDedupCache(sosId: string) {
    if (this.dedupCache.has(sosId)) {
      this.dedupCache.delete(sosId);
    }
    this.dedupCache.add(sosId);
    if (this.dedupCache.size > DEDUP_CACHE_SIZE) {
      const firstId = this.dedupCache.keys().next().value;
      if (firstId) this.dedupCache.delete(firstId);
    }
  }

  /**
   * Starts Central mode scanning for Suraksha SOS devices.
   */
  public startScanning(): void {
    if (this.isScanning || !this.manager) return;
    this.isScanning = true;

    this.manager.startDeviceScan(
      [SURAKSHA_SERVICE_UUID],
      { allowDuplicates: false },
      async (error, device) => {
        if (error) {
          this.emit('onError', error);
          return;
        }

        if (device) {
          await this.handleDiscoveredDevice(device);
        }
      }
    );
  }

  /**
   * Connects to a discovered device, reads the characteristic, and processes the payload.
   */
  private async handleDiscoveredDevice(device: Device): Promise<void> {
    try {
      // Connect to GATT
      const connectedDevice = await device.connect();
      await connectedDevice.discoverAllServicesAndCharacteristics();
      
      // Read the characteristic
      const characteristic = await connectedDevice.readCharacteristicForService(
        SURAKSHA_SERVICE_UUID,
        SURAKSHA_SOS_CHARACTERISTIC_UUID
      );

      // Disconnect immediately to free up mesh resources
      await connectedDevice.cancelConnection();

      if (characteristic.value) {
        const decodedStr = Buffer.from(characteristic.value, 'base64').toString('utf-8');
        const gattPayload = JSON.parse(decodedStr);
        
        // Integrity check
        if (this.calculateChecksum(JSON.stringify(gattPayload.payload)) !== gattPayload.checksum) {
          console.warn('Checksum mismatch, payload corrupted.');
          return;
        }

        const payload: SOSPayload = gattPayload.payload;
        
        // Deduplication
        if (this.dedupCache.has(payload.sosId)) {
          return; // Already processed
        }
        this.addToDedupCache(payload.sosId);

        this.emit('onSOSReceived', payload);
      }
    } catch (err) {
      console.warn('Failed to read from discovered device', err);
    }
  }

  /**
   * Stops Central mode scanning.
   */
  public stopScanning(): void {
    if (!this.isScanning || !this.manager) return;
    this.manager.stopDeviceScan();
    this.isScanning = false;
  }

  /**
   * Relays an received SOS payload.
   */
  public relayPayload(payload: SOSPayload, selfDeviceId: string, selfLocation?: SOSLocation): void {
    if (payload.hopCount >= MAX_HOP_COUNT) {
      console.log('Max hops reached, dropping payload.');
      return;
    }

    const relayedPayload: SOSPayload = {
      ...payload,
      hopCount: payload.hopCount + 1,
      relayChain: [
        ...payload.relayChain,
        {
          deviceId: selfDeviceId,
          timestamp: new Date().toISOString(),
          location: selfLocation
        }
      ]
    };

    // Jitter delay to avoid collisions in mesh flooding
    const jitter = Math.random() * (BLE_RELAY_JITTER_MAX_MS - BLE_RELAY_JITTER_MIN_MS) + BLE_RELAY_JITTER_MIN_MS;
    
    setTimeout(() => {
      this.startAdvertising(relayedPayload)
        .then(() => this.emit('onRelayComplete', relayedPayload))
        .catch(e => this.emit('onError', e));
    }, jitter);
  }

  /**
   * Broadcasts an SOS cancellation.
   */
  public async broadcastCancellation(cancellation: SOSCancellation): Promise<void> {
    try {
      const base64Data = Buffer.from(JSON.stringify(cancellation), 'utf-8').toString('base64');
      await NativePeripheralBridge.startAdvertising(
        SURAKSHA_SERVICE_UUID,
        SURAKSHA_CANCEL_CHARACTERISTIC_UUID,
        base64Data
      );
      // Wait for a few seconds to ensure broadcast, then stop
      setTimeout(() => {
        NativePeripheralBridge.stopAdvertising();
      }, 5000);
    } catch (err) {
      this.emit('onError', err);
    }
  }

  /**
   * Utility Haversine calculation for distance.
   */
  public calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371e3; // Earth radius in meters
    const rad = Math.PI / 180;
    const phi1 = lat1 * rad;
    const phi2 = lat2 * rad;
    const dPhi = (lat2 - lat1) * rad;
    const dLambda = (lon2 - lon1) * rad;

    const a = Math.sin(dPhi/2) * Math.sin(dPhi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(dLambda/2) * Math.sin(dLambda/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
  }

  /**
   * Cleanup resources.
   */
  public destroy(): void {
    this.stopScanning();
    this.stopAdvertising();
    if (this.manager) this.manager.destroy();
    this.removeAllListeners();
  }
}
