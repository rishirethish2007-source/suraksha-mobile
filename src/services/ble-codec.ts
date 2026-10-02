import { Buffer } from 'buffer';
import { SOSPayload, SOSType, SOSMessageType, SOSStatus, DeliveryMethod } from '../interfaces/sos.types';

export function isLivePayload(payload: SOSPayload): boolean {
  const age = Date.now() - Date.parse(payload.timestamp);
  return typeof payload.sosId === 'string' && payload.sosId.length > 0 &&
    typeof payload.userId === 'string' && typeof payload.userName === 'string' &&
    Object.values(SOSType).includes(payload.sosType) && payload.messageType === SOSMessageType.SOS_ALERT &&
    Number.isFinite(age) && age >= -300000 && age < payload.ttlSeconds * 1000 &&
    Number.isInteger(payload.ttlSeconds) && payload.ttlSeconds > 0 && payload.ttlSeconds <= 3600 &&
    Number.isInteger(payload.hopCount) && payload.hopCount >= 0 &&
    Number.isInteger(payload.maxHops) && payload.maxHops >= 0 && payload.maxHops <= 15 && payload.hopCount <= payload.maxHops &&
    Array.isArray(payload.relayChain) && payload.relayChain.length <= 15 &&
    !!payload.location && Number.isFinite(payload.location.latitude) && Math.abs(payload.location.latitude) <= 90 &&
    Number.isFinite(payload.location.longitude) && Math.abs(payload.location.longitude) <= 180;
}

export function encodePayload(payload: SOSPayload): string {
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  // Never send a bearer token to strangers over Bluetooth. Relay history is compact.
  const packet = [1, payload.sosId, payload.userId, payload.userName, payload.userPhone, payload.sosType,
    [payload.location.latitude, payload.location.longitude, payload.location.accuracy], payload.timestamp,
    payload.originDeviceId, payload.hopCount, payload.maxHops,
    payload.relayChain.map(node => [node.deviceId, node.timestamp]), payload.ttlSeconds, payload.message ?? null];
  const data = Buffer.from(JSON.stringify(packet), 'utf8');
  if (data.length > 512) throw new Error('Alert is too large for BLE; retained for online delivery.');
  return data.toString('base64');
}

export function decodePayload(base64: string): SOSPayload {
  const data = Buffer.from(base64, 'base64');
  if (data.length > 512) throw new Error('Oversized BLE payload');
  const p = JSON.parse(data.toString('utf8'));
  if (!Array.isArray(p) || p[0] !== 1 || p.length !== 14 || !Array.isArray(p[6]) || !Array.isArray(p[11])) throw new Error('Invalid BLE packet');
  const payload: SOSPayload = {
    sosId: p[1], userId: p[2], userName: p[3], userPhone: p[4], sosType: p[5],
    location: { latitude: p[6][0], longitude: p[6][1], accuracy: p[6][2], provider: 'network' },
    timestamp: p[7], createdAt: p[7], originDeviceId: p[8], hopCount: p[9], maxHops: p[10],
    relayChain: p[11].map((node: string[]) => ({ deviceId: node[0], timestamp: node[1] })),
    ttlSeconds: p[12], message: p[13] ?? undefined, messageType: SOSMessageType.SOS_ALERT,
    deliveryMethod: DeliveryMethod.BLE_RELAY, status: SOSStatus.ACTIVE,
  };
  if (!isLivePayload(payload)) throw new Error('Invalid or expired BLE alert');
  return payload;
}
