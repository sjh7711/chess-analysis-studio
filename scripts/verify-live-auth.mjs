import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

if (!process.env.CHESS_TEST_ORIGIN) throw new Error('Set CHESS_TEST_ORIGIN to the server you intend to test.');
const origin = new URL(process.env.CHESS_TEST_ORIGIN).origin;
const nickname = '검증_' + randomBytes(6).toString('hex');
const password = randomBytes(32).toString('base64url');
let cookie = '';
async function api(path, body) {
  const response = await fetch(`${origin}/api/play/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const cookies = response.headers.getSetCookie();
  const session = cookies.find(value => value.startsWith('__Host-chess-session='));
  if (session) {
    assert.match(session, /HttpOnly/); assert.match(session, /Secure/); assert.match(session, /SameSite=Lax/);
    cookie = session.split(';')[0];
  }
  const json = await response.json();
  assert.equal(response.ok, true, `HTTP ${response.status}: ${json.error || 'request failed'}`);
  return json;
}
try {
  assert.equal((await api('me')).signedIn, false);
  const created = await api('auth/signup', { nickname, password });
  assert.equal(created.profile.nickname, nickname);
  assert.ok(cookie, 'Secure session cookie must reach the client');
  assert.equal((await api('me')).profile.friendCode, created.profile.friendCode);
  await api('auth/logout', {});
  assert.equal((await api('me')).signedIn, false);
  const login = await api('auth/login', { nickname, password });
  assert.equal(login.profile.friendCode, created.profile.friendCode);
  assert.equal((await api('me')).signedIn, true);
  console.log('PASS: production signup, Secure/HttpOnly cookies, persisted session, logout, password login, same profile');
} finally {
  if (cookie) await api('auth/logout', {});
}
