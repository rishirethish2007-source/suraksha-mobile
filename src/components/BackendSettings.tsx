import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Button } from 'react-native';
import { API_ORIGIN, loadApiSettings } from '../constants/api';
import { checkAndSaveBackend } from '../services/backend-settings.service';

export function BackendSettings({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false), [value, setValue] = useState(API_ORIGIN);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => { void loadApiSettings().then(() => setValue(API_ORIGIN)).catch(e => setMessage(e.message)); }, []);
  async function save() {
    setBusy(true); setMessage('');
    try {
      const origin = await checkAndSaveBackend(value); setValue(origin); setMessage('Server address saved. Your sign-in is preserved for this backend.'); onSaved();
    } catch (e) { setMessage(e instanceof Error ? e.message : 'Unable to save server address'); }
    finally { setBusy(false); }
  }
  return <View style={{ padding: 16, gap: 8 }}>
    <Button title={open ? 'Close settings' : 'Settings — backend address'} onPress={() => setOpen(!open)} />
    {open && <>
      <Text style={{ color: '#ddd' }}>Backend address (IP and port)</Text>
      <TextInput accessibilityLabel="Backend address" value={value} onChangeText={setValue} autoCapitalize="none" autoCorrect={false} keyboardType="url" style={{ color: '#fff', padding: 12, borderWidth: 1, borderColor: '#888' }} placeholder="http://172.18.66.69:8000" placeholderTextColor="#aaa" />
      <Text style={{ color: '#bbb' }}>Use the laptop’s current Wi-Fi IPv4 address. Local HTTP is for trusted-network testing; use HTTPS for deployment.</Text>
      <Button title="Check connection and save" disabled={busy} onPress={() => { void save(); }} />
      {!!message && <Text style={{ color: '#ddd' }}>{message}</Text>}
    </>}
  </View>;
}
