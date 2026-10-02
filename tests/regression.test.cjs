const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Run the real TypeScript services with only device/network boundaries mocked.
function loader(mocks = {}, globals = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(__dirname, '..', file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} }; cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const localRequire = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name + '.ts'));
      return require(name);
    };
    vm.runInNewContext(code, { module, exports: module.exports, require: localRequire,
      console, setTimeout, clearTimeout, Date, Headers, FormData, AbortController,
      process: { env: { EXPO_PUBLIC_API_URL: 'https://example.test' } }, ...globals }, { filename: file });
    return module.exports;
  }
  return load;
}
function payload(id = 'sos-1') {
  return { sosId: id, userId: 'owner', userName: 'Name', userPhone: '123', sosType: 'MEDICAL',
    messageType: 'SOS_ALERT', location: { latitude: 12, longitude: 77, accuracy: 0, provider: 'gps' },
    timestamp: new Date().toISOString(), createdAt: new Date().toISOString(), originDeviceId: 'device',
    hopCount: 0, maxHops: 15, relayChain: [], ttlSeconds: 3600, status: 'ACTIVE', deliveryMethod: 'DIRECT_ONLINE' };
}

test('API sends backend field names and keeps credentials out of JSON', async () => {
  let call;
  const { SOSApiService } = loader({}, { fetch: async (url, options) => {
    call = { url, options };
    return new Response(JSON.stringify({ success: true, sos_id: 'sos-1', is_duplicate: true, message: 'ok', server_timestamp: 'now' }));
  } })('src/services/sos-api.service.ts');
  const input = { ...payload(), authToken: 'secret', relayChain: [{ deviceId: 'relay', timestamp: new Date().toISOString(), location: payload().location }] };
  const result = await SOSApiService.sendSOS(input);
  const sent = JSON.parse(call.options.body);
  assert.equal(sent.sos_id, 'sos-1'); assert.equal(sent.location.lat, 12);
  assert.equal(sent.relay_chain[0].device_id, 'relay'); assert.equal(sent.relay_chain[0].location.lng, 77);
  assert.ok(!call.options.body.includes('secret')); assert.equal(call.options.headers.get('Authorization'), 'Bearer secret');
  assert.equal(result.sosId, 'sos-1'); assert.equal(result.isDuplicate, true);
});

test('API rejects HTTP and application failures without retrying 4xx', async () => {
  let calls = 0;
  const load = loader({}, { fetch: async () => { calls++; return new Response(JSON.stringify({ detail: 'Denied' }), { status: 403 }); } });
  await assert.rejects(load('src/services/sos-api.service.ts').SOSApiService.sendSOS(payload()), /Denied/);
  assert.equal(calls, 1);
  const api = loader({}, { fetch: async () => new Response(JSON.stringify({ success: false, message: 'Rejected' })) })('src/services/sos-api.service.ts');
  await assert.rejects(api.SOSApiService.sendSOS(payload()), /Rejected/);
});

test('nearby queries and response mapping follow backend contract', async () => {
  let url;
  const api = loader({}, { fetch: async value => {
    url = value;
    return new Response(JSON.stringify([{ sos_id: 'nearby', user_id: 'owner', user_name: 'Name', sos_type: 'FIRE', message_type: 'SOS_ALERT',
      location: { lat: 10, lng: 20 }, client_timestamp: '2026-10-03T00:00:00Z', created_at: '2026-10-03T00:00:00Z',
      status: 'ACTIVE', hop_count: 1, delivery_method: 'BLE_RELAY', relay_chain: null }]));
  } })('src/services/sos-api.service.ts');
  const events = await api.SOSApiService.getActiveSOS(10,20,7);
  assert.match(url, /radius_km=7/); assert.equal(events[0].sosId, 'nearby');
  assert.equal(events[0].location.longitude, 20);
});

test('BLE round-trip excludes bearer tokens and rejects expired/oversized packets', () => {
  const { encodePayload, decodePayload } = loader()('src/services/ble-codec.ts');
  const encoded = encodePayload({ ...payload(), authToken: 'never-broadcast-this' });
  assert.ok(!Buffer.from(encoded, 'base64').toString().includes('never-broadcast-this'));
  assert.equal(decodePayload(encoded).sosId, 'sos-1');
  assert.throws(() => encodePayload({ ...payload(), timestamp: '2000-01-01T00:00:00Z' }), /expired/);
  assert.throws(() => encodePayload({ ...payload(), message: 'x'.repeat(1000) }), /too large/);
  assert.throws(() => decodePayload(Buffer.from('{}').toString('base64')), /Invalid/);
});

function queueHarness() {
  const store = new Map();
  let online = false; let failSend = false; let failCancel = false; let advertise = false;
  const sent = [];
  const storage = { async getItem(key) { await Promise.resolve(); return store.get(key) ?? null; },
    async setItem(key,value) { await Promise.resolve(); store.set(key,value); } };
  class BLEMeshService {
    async startAdvertising() { if (!advertise) throw Error('No BLE'); }
    async stopAdvertising() {}
  }
  class ApiError extends Error {}
  const api = { setAuthToken() {}, async sendSOS(p) { if (failSend) throw Error('Offline'); sent.push(p); return { success: true }; },
    async cancelSOS() { if (failCancel) throw Error('Offline'); return { success: true }; } };
  const load = loader({
    '@react-native-async-storage/async-storage': storage,
    './location.service': { LocationService: { async getCurrentLocation() { return payload().location; } } },
    './network.service': { NetworkService: { async checkConnectivity() { return { isOnline: online }; } } },
    './sos-api.service': { SOSApiService: api, ApiError }, './ble-mesh.service': { BLEMeshService },
  });
  return { service: load('src/services/sos-trigger.service.ts').SOSTriggerService, store, sent,
    setOnline(value) { online=value; }, setFailSend(value) { failSend=value; }, setFailCancel(value) { failCancel=value; },
    setAdvertise(value) { advertise=value; } };
}
const params = { userId:'owner', userName:'Name', userPhone:'123', sosType:'MEDICAL', authToken:'secret' };

test('offline SOS stays queued and concurrent additions are not lost', async () => {
  const h = queueHarness();
  const results = await Promise.all([h.service.triggerSOS(params),h.service.triggerSOS(params)]);
  assert.equal(results[0].deliveryMethod, 'OFFLINE_QUEUED');
  const raw = h.store.get('@suraksha_sos_queue');
  assert.equal(JSON.parse(raw).length, 2); assert.ok(!raw.includes('secret'));
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 2); assert.equal(h.store.get('@suraksha_sos_queue'),'[]');
});

test('failed retry remains durable and cancellation cannot resurrect an alert', async () => {
  const h = queueHarness();
  const alert = await h.service.triggerSOS(params);
  h.setOnline(true); h.setFailSend(true);
  await h.service.retryPendingQueue();
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_queue')).length, 1);
  h.setFailCancel(true);
  assert.equal(await h.service.cancelSOS(alert.sosId, 'owner'), false);
  assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
  h.setFailSend(false); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 0);
  assert.equal(JSON.parse(h.store.get('@suraksha_sos_cancellations')).length, 1);
  h.setFailCancel(false); await h.service.retryPendingQueue();
  assert.equal(h.store.get('@suraksha_sos_cancellations'), '[]');
});

test('expired alerts are discarded without being uploaded', async () => {
  const h = queueHarness();
  h.store.set('@suraksha_sos_queue', JSON.stringify([{ ...payload(), timestamp:'2000-01-01T00:00:00Z' }]));
  h.setOnline(true); await h.service.retryPendingQueue();
  assert.equal(h.sent.length, 0); assert.equal(h.store.get('@suraksha_sos_queue'), '[]');
});
