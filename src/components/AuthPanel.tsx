import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, Button } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { establishSession, oidcIssuer, oidcClient, Session, passwordSignIn, signOut } from '../services/session.service';
import { enrollDevice } from '../services/origin-security';
import { API_ORIGIN, loadApiSettings } from '../constants/api';
import { SOSTriggerService } from '../services/sos-trigger.service';
WebBrowser.maybeCompleteAuthSession();

export function AuthPanel({ onSession }: { onSession: (session: Session) => void }) {
  const [origin, setOrigin] = useState(API_ORIGIN);
  useEffect(() => { void loadApiSettings().then(() => setOrigin(API_ORIGIN)).catch(() => undefined); }, []);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testToken, setTestToken] = useState('');
  const [email, setEmail] = useState(''), [password, setPassword] = useState('');
  const [name, setName] = useState(''), [phone, setPhone] = useState('');
  const [register, setRegister] = useState(false), [advanced, setAdvanced] = useState(false);
  async function finish(token: string, refresh?: string, expires?: number) {
    const session = await establishSession(token, refresh, expires);
    try { await enrollDevice(await SOSTriggerService.getDeviceId(), session.user.user_id); }
    catch (error) { await signOut(); throw error; }
    onSession(session);
  }
  async function login() {
    setBusy(true); setError('');
    try {
      if (!oidcIssuer || !oidcClient) throw new Error('Configure the common platform OIDC issuer and mobile client ID.');
      const discovery = await AuthSession.fetchDiscoveryAsync(oidcIssuer);
      const redirectUri = AuthSession.makeRedirectUri({ scheme: 'suraksha', path: 'auth-callback' });
      const request = new AuthSession.AuthRequest({ clientId: oidcClient, redirectUri, scopes: ['openid', 'profile', 'offline_access'],
        responseType: AuthSession.ResponseType.Code, usePKCE: true });
      const result = await request.promptAsync(discovery);
      if (result.type !== 'success') return;
      const tokens = await AuthSession.exchangeCodeAsync({ clientId: oidcClient, redirectUri, code: result.params.code,
        extraParams: { code_verifier: request.codeVerifier! } }, discovery);
      await finish(tokens.accessToken, tokens.refreshToken, tokens.expiresIn);
    } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed'); }
    finally { setBusy(false); }
  }
  return <View style={{ padding: 16, gap: 8 }}>
    <Text style={{ color: '#fff', fontSize: 20, fontWeight: 'bold' }}>{register ? 'Create your account' : 'Sign in'}</Text>
    <Text style={{ color: '#ccc' }}>Backend: {origin}</Text>
    <TextInput accessibilityLabel="Email" placeholder="Email" placeholderTextColor="#aaa" value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false} keyboardType="email-address" style={{ color: '#fff', padding: 12, borderWidth: 1, borderColor: '#888' }} />
    <TextInput accessibilityLabel="Password" placeholder="Password (at least 12 characters)" placeholderTextColor="#aaa" value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" style={{ color: '#fff', padding: 12, borderWidth: 1, borderColor: '#888' }} />
    {register && <>
      <TextInput accessibilityLabel="Full name" placeholder="Full name" placeholderTextColor="#aaa" value={name} onChangeText={setName} style={{ color: '#fff', padding: 12, borderWidth: 1, borderColor: '#888' }} />
      <TextInput accessibilityLabel="Phone number" placeholder="Phone number" placeholderTextColor="#aaa" value={phone} onChangeText={setPhone} keyboardType="phone-pad" style={{ color: '#fff', padding: 12, borderWidth: 1, borderColor: '#888' }} />
    </>}
    <Button title={busy ? 'Connecting…' : register ? 'Create account and sign in' : 'Sign in to my account'} disabled={busy} onPress={async () => {
      setBusy(true); setError('');
      try {
        const session = await passwordSignIn(email, password, register ? { name: name.trim(), phone: phone.trim() } : undefined);
        try { await enrollDevice(await SOSTriggerService.getDeviceId(), session.user.user_id); }
        catch (error) { await signOut(); throw error; }
        setPassword(''); onSession(session);
      } catch (e) { setError(e instanceof Error ? e.message : 'Sign-in failed'); }
      finally { setBusy(false); }
    }} />
    <Text style={{ color: '#aaa' }}>Stay signed in until you sign out or your session is revoked. No daily token copying.</Text>
    <Button title={register ? 'Already have an account? Sign in' : 'New user? Create an account'} disabled={busy} onPress={() => { setRegister(!register); setError(''); }} />
    {!!oidcIssuer && !!oidcClient && <Button title="Organisation sign-in" disabled={busy} onPress={login} />}
    <Button title={advanced ? 'Hide test-token sign-in' : 'Advanced: test-token sign-in'} onPress={() => setAdvanced(!advanced)} />
    {advanced && process.env.EXPO_PUBLIC_ENABLE_TEST_LOGIN === 'true' && <>
      <Text style={{ color: '#fff', fontWeight: 'bold' }}>Local test-account sign-in</Text>
      <Text selectable style={{ color: '#ddd' }}>Backend: {origin}</Text>
      <Text style={{ color: '#ddd' }}>Keep your laptop backend running and both devices on the same Wi-Fi. Paste a phone token from dev-tokens.json on your laptop.</Text>
      <TextInput accessibilityLabel="Local test token" secureTextEntry autoCapitalize="none" value={testToken} onChangeText={setTestToken}
        placeholder="Paste a local test token" placeholderTextColor="#aaa" style={{ color: '#fff', padding: 10, borderWidth: 1, borderColor: '#888' }} />
      <Button title="Connect test account and enroll device" disabled={busy} onPress={async () => {
        setBusy(true); setError('');
        try { await finish(testToken.trim(), undefined, 86400); } catch (e) { setError(e instanceof Error ? e.message : 'Enrollment failed'); }
        finally { setBusy(false); }
      }} />
    </>}
    {!!error && <Text style={{ color: '#ff9b90' }}>{error}</Text>}
  </View>;
}
