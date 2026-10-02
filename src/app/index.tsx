import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Animated,
  TouchableOpacity,
  Modal,
  Vibration,
  TextInput,
  ScrollView,
} from 'react-native';

// ── Config ──────────────────────────────────────────────────────
import { SOSTriggerService } from '../services/sos-trigger.service';
import { SOSApiService } from '../services/sos-api.service';
import { useBLEMesh } from '../hooks/useBLEMesh';
import { NetworkService } from '../services/network.service';
import { DeliveryMethod, SOSType, SOSPayload } from '../interfaces/sos.types';

const SOS_TYPES = Object.values(SOSType);

const LONG_PRESS_MS = 3000;

function RelayPanel({ deviceId }: { deviceId: string }) {
  const { isScanning, nearbySOSEvents, error } = useBLEMesh(deviceId);
  return <View style={{ padding: 16 }}>
    <Text style={{ color: '#ddd' }}>{isScanning ? 'Scanning for nearby SOS alerts' : 'Starting Bluetooth…'}</Text>
    {error && <Text style={{ color: '#ff9b90' }}>{error}</Text>}
    {nearbySOSEvents.map(event => <Text key={event.sosId} style={{ color: '#fff', marginTop: 8 }}>
      Nearby {event.sosType}: {event.userName}. Received over Bluetooth; origin is unverified.
    </Text>)}
  </View>;
}

// ── Main Screen ─────────────────────────────────────────────────
export default function Index() {
  const [isPressing, setIsPressing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'queued' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');
  const [userId, setUserId] = useState('');
  const [userName, setUserName] = useState('');
  const [userPhone, setUserPhone] = useState('');
  const [token, setToken] = useState('');
  const [lastSOS, setLastSOS] = useState<SOSPayload | null>(null);
  const sending = useRef(false);
  const [relayDevice, setRelayDevice] = useState<string | null>(null);
  useEffect(() => {
    SOSApiService.setAuthToken(token.trim() || undefined);
    const retry = () => { void SOSTriggerService.retryPendingQueue().catch(() => undefined); };
    retry();
    const unsubscribe = NetworkService.subscribe(online => { if (online) retry(); });
    const timer = setInterval(retry, 30000);
    return () => { unsubscribe(); clearInterval(timer); };
  }, [token]);

  const [pulseAnim] = useState(() => new Animated.Value(1));
  const [progressAnim] = useState(() => new Animated.Value(0));
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (pressTimer.current) clearTimeout(pressTimer.current); }, []);

  // Pulse animation
  useEffect(() => {
    if (status === 'idle' && !isPressing) {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.12, duration: 1000, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 1000, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [status, isPressing, pulseAnim]);

  // ── Press handlers ────────────────────────────────────────────
  const onPressIn = () => {
    if (sending.current || showPicker) return;
    setIsPressing(true);
    Vibration.vibrate(50);
    Animated.timing(progressAnim, { toValue: 1, duration: LONG_PRESS_MS, useNativeDriver: false }).start();

    pressTimer.current = setTimeout(() => {
      setIsPressing(false);
      Vibration.vibrate([0, 300, 150, 300]);
      setShowPicker(true);
    }, LONG_PRESS_MS);
  };

  const onPressOut = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    setIsPressing(false);
    Animated.timing(progressAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start();
  };

  const sendSOS = async (type: SOSType) => {
    if (sending.current) return;
    sending.current = true;
    setShowPicker(false);
    setStatus('sending');
    setStatusMsg('Acquiring your location and sending SOS…');
    try {
      const payload = await SOSTriggerService.triggerSOS({ userId, userName, userPhone,
        authToken: token.trim() || undefined, sosType: type });
      setLastSOS(payload);
      if (payload.deliveryMethod === DeliveryMethod.DIRECT_ONLINE) {
        setStatus('sent');
        setStatusMsg(`SOS received by server. ID: ${payload.sosId.slice(0, 8)}`);
      } else {
        setStatus('queued');
        setStatusMsg(payload.deliveryMethod === DeliveryMethod.BLE_RELAY
          ? 'SOS saved locally and advertising over Bluetooth. Server receipt is not confirmed.'
          : 'SOS saved on this device. Waiting for connectivity; server receipt is not confirmed.');
      }
    } catch (error) {
      setStatus('error');
      setStatusMsg(error instanceof Error ? error.message : 'Unable to send SOS.');
    } finally {
      sending.current = false;
      progressAnim.setValue(0);
    }
  };

  const cancelSOS = async () => {
    if (!lastSOS || sending.current) return;
    sending.current = true;
    try {
      const confirmed = await SOSTriggerService.cancelSOS(lastSOS.sosId, lastSOS.userId, undefined, token.trim() || undefined);
      setStatus(confirmed ? 'idle' : 'queued');
      setStatusMsg(confirmed ? 'SOS cancellation confirmed by server.' : 'Cancellation saved. Server confirmation is pending.');
      setLastSOS(null);
    } catch (error) {
      setStatus('error');
      setStatusMsg(error instanceof Error ? error.message : 'Unable to save cancellation.');
    } finally { sending.current = false; }
  };

  // ── Progress bar height ───────────────────────────────────────
  const progressHeight = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  // ── Button label ──────────────────────────────────────────────
  const label = status === 'sending' ? '...' : status === 'sent' ? '✓' : isPressing ? 'HOLD' : 'SOS';

  return (
    <SafeAreaView style={styles.root}>
      <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>🛡️ Suraksha</Text>
      <Text style={styles.subtitle}>Emergency Response Network</Text>
      <View style={{ paddingHorizontal: 20, gap: 8 }}>
        <TextInput accessibilityLabel="User ID" style={styles.input} placeholder="User ID from your account" placeholderTextColor="#888" value={userId} onChangeText={setUserId} autoCapitalize="none" />
        <TextInput accessibilityLabel="Name" style={styles.input} placeholder="Your name" placeholderTextColor="#888" value={userName} onChangeText={setUserName} />
        <TextInput accessibilityLabel="Phone" style={styles.input} placeholder="Phone number" placeholderTextColor="#888" value={userPhone} onChangeText={setUserPhone} keyboardType="phone-pad" />
        <TextInput accessibilityLabel="Session token" style={styles.input} placeholder="Session token (until sign-in is integrated)" placeholderTextColor="#888" value={token} onChangeText={setToken} autoCapitalize="none" secureTextEntry />
      </View>

      <TouchableOpacity style={styles.cancelBtn} onPress={() => {
        if (relayDevice) setRelayDevice(null);
        else void SOSTriggerService.getDeviceId().then(setRelayDevice).catch(() => setStatusMsg('Unable to initialize this device.'));
      }}><Text style={styles.statusText}>{relayDevice ? 'Stop nearby relay' : 'Enable nearby relay'}</Text></TouchableOpacity>
      {relayDevice && <RelayPanel deviceId={relayDevice} />}
      {/* ── SOS Button ── */}
      <View style={styles.center}>
        <Animated.View
          style={[styles.outerRing, { transform: [{ scale: pulseAnim }] }]}
          onStartShouldSetResponder={() => true}
          onResponderGrant={onPressIn}
          onResponderRelease={onPressOut}
          onResponderTerminate={onPressOut}
        >
          <View style={styles.innerCircle}>
            <Animated.View style={[styles.fill, { height: progressHeight }]} />
            <Text style={styles.sosText}>{label}</Text>
          </View>
        </Animated.View>

        <Text style={styles.hint}>Long press for 3 seconds to trigger SOS</Text>
      </View>

      {/* ── Status bar ── */}
      {statusMsg !== '' && (
        <View style={[styles.statusBox, status === 'sent' ? styles.green : status === 'error' ? styles.red : styles.yellow]}>
          <Text style={styles.statusText}>{statusMsg}</Text>
        </View>
      )}

      {lastSOS && <TouchableOpacity style={styles.cancelBtn} onPress={cancelSOS}><Text style={styles.statusText}>Cancel this SOS</Text></TouchableOpacity>}
      {/* ── Type Picker Modal ── */}
      <Modal visible={showPicker} transparent animationType="slide" onRequestClose={() => setShowPicker(false)}>
        <View style={styles.modalBg}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Select Emergency Type</Text>
            {SOS_TYPES.map((t) => (
              <TouchableOpacity key={t} style={styles.typeBtn} onPress={() => sendSOS(t)}>
                <Text style={styles.typeBtnText}>{t}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowPicker(false)}>
              <Text style={styles.cancelBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
      </ScrollView>
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────
const styles = StyleSheet.create({
  input: { color: "#fff", borderWidth: 1, borderColor: "#444", borderRadius: 8, padding: 8 },
  root: { flex: 1, backgroundColor: '#0D0D0D' },
  title: { fontSize: 30, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginTop: 20 },
  subtitle: { fontSize: 14, color: '#777', textAlign: 'center', marginTop: 4 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },

  outerRing: {
    width: 220, height: 220, borderRadius: 110,
    backgroundColor: 'rgba(255,59,48,0.15)',
    justifyContent: 'center', alignItems: 'center',
  },
  innerCircle: {
    width: 170, height: 170, borderRadius: 85,
    backgroundColor: '#FF3B30',
    justifyContent: 'center', alignItems: 'center',
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#FF3B30', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.45, shadowRadius: 16,
  },
  fill: { position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.25)' },
  sosText: { color: '#fff', fontSize: 52, fontWeight: '900', zIndex: 2 },
  hint: { color: '#555', marginTop: 24, fontSize: 13 },

  statusBox: { marginHorizontal: 20, marginBottom: 30, padding: 16, borderRadius: 12 },
  green: { backgroundColor: 'rgba(76,175,80,0.15)', borderWidth: 1, borderColor: '#4CAF50' },
  red: { backgroundColor: 'rgba(255,59,48,0.15)', borderWidth: 1, borderColor: '#FF3B30' },
  yellow: { backgroundColor: 'rgba(255,215,0,0.15)', borderWidth: 1, borderColor: '#FFD700' },
  statusText: { color: '#eee', textAlign: 'center', fontSize: 14, lineHeight: 22 },

  modalBg: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' },
  modalCard: { backgroundColor: '#1A1A1A', padding: 24, borderTopLeftRadius: 24, borderTopRightRadius: 24 },
  modalTitle: { fontSize: 20, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginBottom: 20 },
  typeBtn: { padding: 16, backgroundColor: '#2A2A2A', borderRadius: 12, marginBottom: 10 },
  typeBtnText: { fontSize: 16, textAlign: 'center', fontWeight: '600', color: '#FF3B30' },
  cancelBtn: { padding: 16, marginTop: 8 },
  cancelBtnText: { fontSize: 16, textAlign: 'center', color: '#777' },
});
