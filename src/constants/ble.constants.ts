/**
 * @fileoverview Configuration constants for the Suraksha BLE Mesh protocol.
 */

// Custom 128-bit Service UUID for Suraksha SOS Discovery
export const SURAKSHA_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';

// Characteristic UUID for reading the full SOS payload
export const SURAKSHA_SOS_CHARACTERISTIC_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';

// Characteristic UUID for reading cancellation payloads
export const SURAKSHA_CANCEL_CHARACTERISTIC_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

// Maximum times a single message can be relayed to prevent mesh flooding
export const MAX_HOP_COUNT = 15;

// BLE Scanning interval in milliseconds
export const BLE_SCAN_INTERVAL_MS = 2000;

// BLE Scan active window duration in milliseconds
export const BLE_SCAN_WINDOW_MS = 1500;

// BLE Advertising interval (400ms balances battery life and discoverability)
export const BLE_ADV_INTERVAL_MS = 400;

// Minimum random delay before relaying a message (collision avoidance)
export const BLE_RELAY_JITTER_MIN_MS = 50;

// Maximum random delay before relaying a message
export const BLE_RELAY_JITTER_MAX_MS = 250;

// Maximum Transmission Unit for GATT payload transfers
export const GATT_MTU_SIZE = 512;

// Default Time-To-Live for SOS messages (1 hour)
export const SOS_TTL_SECONDS = 3600;

// Maximum number of entries in the deduplication cache
export const DEDUP_CACHE_SIZE = 1000;

// Max SOS alerts a single user can trigger per minute
export const SOS_RATE_LIMIT_PER_MINUTE = 5;

// Current payload protocol version
export const PAYLOAD_VERSION = 1;
