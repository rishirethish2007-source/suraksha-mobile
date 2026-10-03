import React, { useState } from 'react';
import { View, Text, TextInput, Button } from 'react-native';
import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { establishSession, oidcIssuer, oidcClient, Session } from '../services/session.service';
import { enrollDevice } from '../services/origin-security';
import { API_ORIGIN } from '../constants/api';
import { SOSTriggerService } from '../services/sos-trigger.service';
WebBrowser.maybeCompleteAuthSession();

export function AuthPanel({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [testToken, setTestToken] = useState('');
  async function finish(token: string, refresh?: string, expires?: number) {
    const session = await establishSession(token, refresh, expires);
    await enrollDevice(await SOSTriggerService.getDeviceId(), session.user.user_id);
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
    {oidcIssuer && oidcClient ? <Button title="Sign in to Suraksha" disabled={busy} onPress={login} /> :
      process.env.EXPO_PUBLIC_ENABLE_TEST_LOGIN !== 'true' && <Text style={{ color: '#ff9b90' }}>This build has no login provider configured. Install a configured build.</Text>}
    {process.env.EXPO_PUBLIC_ENABLE_TEST_LOGIN === 'true' && <>
      <Text style={{ color: '#fff', fontWeight: 'bold' }}>Local test-account sign-in</Text>
      <Text selectable style={{ color: '#ddd' }}>Backend: {API_ORIGIN}</Text>
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
