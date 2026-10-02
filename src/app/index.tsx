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
  Alert,
} from 'react-native';

// ── Config ──────────────────────────────────────────────────────
const API_BASE = 'http://10.61.126.110:8000/api/v1';

const SOS_TYPES = ['MEDICAL', 'FIRE', 'FLOOD', 'EARTHQUAKE', 'VIOLENCE', 'OTHER'] as const;
type SOSType = (typeof SOS_TYPES)[number];

const LONG_PRESS_MS = 3000;

// ── Simple UUID generator ───────────────────────────────────────
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Main Screen ─────────────────────────────────────────────────
export default function Index() {
  const [isPressing, setIsPressing] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [statusMsg, setStatusMsg] = useState('');

  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
  }, [status, isPressing]);

  // ── Press handlers ────────────────────────────────────────────
  const onPressIn = () => {
    if (status === 'sending') return;
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

  // ── Send SOS directly to backend ─────────────────────────────
  const sendSOS = async (type: SOSType) => {
    setShowPicker(false);
    setStatus('sending');
    setStatusMsg('⏳ Sending SOS to server...');

    const payload = {
      sos_id: uuid(),
      user_id: 'test_user_999',
      user_name: 'Test User',
      user_phone: '+919876543210',
      sos_type: type,
      message_type: 'SOS_ALERT',
      location: {
        lat: 19.076,
        lng: 72.8777,
        altitude: 14.0,
        accuracy: 5.0,
        provider: 'gps',
      },
      status: 'ACTIVE',
      delivery_method: 'DIRECT_ONLINE',
      hop_count: 0,
      max_hops: 15,
      relay_chain: [],
      message: `Emergency ${type} - SOS from Suraksha App`,
      ttl_seconds: 3600,
      client_timestamp: new Date().toISOString(),
    };

    try {
      const res = await fetch(`${API_BASE}/sos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test_token_123' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (res.ok) {
        setStatus('sent');
        setStatusMsg(`✅ SOS received by server!\nID: ${payload.sos_id.substring(0, 8)}...\nType: ${type}`);
        console.log('✅ Server response:', JSON.stringify(data, null, 2));
      } else {
        setStatus('error');
        setStatusMsg(`❌ Server error ${res.status}: ${data.detail || JSON.stringify(data)}`);
        console.error('Server error:', data);
      }
    } catch (err: any) {
      setStatus('error');
      setStatusMsg(`❌ Network error: ${err.message}\n\nIs your backend running on port 8000?`);
      console.error('Network error:', err);
    }

    // Reset after 6 seconds
    setTimeout(() => {
      setStatus('idle');
      setStatusMsg('');
      progressAnim.setValue(0);
    }, 6000);
  };

  // ── Progress bar height ───────────────────────────────────────
  const progressHeight = progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });

  // ── Button label ──────────────────────────────────────────────
  const label = status === 'sending' ? '...' : status === 'sent' ? '✓' : isPressing ? 'HOLD' : 'SOS';

  return (
    <SafeAreaView style={styles.root}>
      <Text style={styles.title}>🛡️ Suraksha</Text>
      <Text style={styles.subtitle}>Emergency Response Network</Text>

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

      {/* ── Type Picker Modal ── */}
      <Modal visible={showPicker} transparent animationType="slide">
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
    </SafeAreaView>
  );
}

// ── Styles ──────────────────────────────────────────────────────
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0D0D0D' },
  title: { fontSize: 30, fontWeight: 'bold', color: '#fff', textAlign: 'center', marginTop: 60 },
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
