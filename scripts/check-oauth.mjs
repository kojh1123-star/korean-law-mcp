#!/usr/bin/env node
// Read-only deployment check. Takes a public URL, never a credential.
if (!process.argv[2]) throw new Error('Usage: node scripts/check-oauth.mjs https://your-domain');
const origin = new URL(process.argv[2]).origin;
if (!origin.startsWith('https://')) throw new Error('Use a public HTTPS origin.');
const get = path => fetch(`${origin}${path}`, { redirect: 'error', signal: AbortSignal.timeout(15000) });
const prmResponse = await get('/.well-known/oauth-protected-resource');
if (!prmResponse.ok) throw new Error(`Resource metadata: HTTP ${prmResponse.status}`);
const prm = await prmResponse.json();
if (prm.resource !== `${origin}/mcp` || !prm.authorization_servers?.includes(origin)) throw new Error('Resource/issuer mismatch.');
const asResponse = await get('/.well-known/oauth-authorization-server');
if (!asResponse.ok) throw new Error(`Authorization metadata: HTTP ${asResponse.status}`);
const as = await asResponse.json();
if (as.issuer !== origin || !as.code_challenge_methods_supported?.includes('S256') || as.authorization_response_iss_parameter_supported !== true) throw new Error('OAuth discovery mismatch.');
for (const key of ['authorization_endpoint', 'token_endpoint', 'registration_endpoint']) {
  if (new URL(as[key]).origin !== origin) throw new Error(`Unexpected ${key}.`);
}
const missing = await get('/mcp');
if (missing.status !== 401 || !missing.headers.get('www-authenticate')?.includes(`${origin}/.well-known/oauth-protected-resource`)) throw new Error('Missing 401 discovery challenge.');
console.log('PASS: HTTPS metadata, resource, issuer, PKCE S256, registration, and MCP challenge.');
console.log('Next: sign in from ChatGPT, allow access, and execute a law search. Employee credentials were not checked.');
