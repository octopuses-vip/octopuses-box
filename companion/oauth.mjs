import crypto from 'node:crypto';

function secureURL(raw) {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('OAuth endpoints require HTTPS (loopback HTTP is allowed)');
  return url;
}
async function fetchJSON(url, options) {
  const response = await fetch(secureURL(url), { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`OAuth endpoint HTTP ${response.status}`);
  const text = await response.text(); if (text.length > 1024 * 1024) throw new Error('OAuth metadata too large'); return JSON.parse(text);
}
export function createOAuthManager(callbackURL) {
  const requests = new Map();
  const prune = () => { for (const [id, req] of requests) if (Date.now() > req.expires) requests.delete(id); };
  return {
    async begin({ resource, clientId }) {
      prune(); if (requests.size >= 20) throw new Error('Too many pending OAuth authorizations');
      const target = secureURL(resource); if (target.search) throw new Error('MCP resource URL must not include a query');
      let protectedResource;
      const candidate = new URL('/.well-known/oauth-protected-resource' + (target.pathname === '/' ? '' : target.pathname), target.origin);
      try { protectedResource = await fetchJSON(candidate); } catch { protectedResource = await fetchJSON(new URL('/.well-known/oauth-protected-resource', target.origin)); }
      if (protectedResource.resource && protectedResource.resource.replace(/\/$/, '') !== target.href.replace(/\/$/, '')) throw new Error('OAuth resource metadata does not match this MCP server');
      const issuer = secureURL(protectedResource.authorization_servers?.[0]);
      const metadataURL = new URL('/.well-known/oauth-authorization-server' + (issuer.pathname === '/' ? '' : issuer.pathname), issuer.origin);
      const metadata = await fetchJSON(metadataURL);
      if (metadata.issuer?.replace(/\/$/, '') !== issuer.href.replace(/\/$/, '')) throw new Error('OAuth issuer mismatch');
      const authorization = secureURL(metadata.authorization_endpoint); const tokenEndpoint = secureURL(metadata.token_endpoint);
      if (!metadata.code_challenge_methods_supported?.includes('S256')) throw new Error('Authorization server does not advertise PKCE S256');
      if (!clientId) {
        if (!metadata.registration_endpoint) throw new Error('This server requires a registered public OAuth client ID');
        const registered = await fetchJSON(metadata.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'octopuses', redirect_uris: [callbackURL], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
        clientId = registered.client_id;
      }
      if (typeof clientId !== 'string' || !clientId) throw new Error('OAuth client ID missing');
      const id = crypto.randomBytes(32).toString('base64url'); const verifier = crypto.randomBytes(32).toString('base64url');
      const state = crypto.randomBytes(32).toString('base64url');
      const scope = Array.isArray(protectedResource.scopes_supported) ? protectedResource.scopes_supported.join(' ') : '';
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId, redirect_uri: callbackURL, state, code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: target.href, ...(scope ? { scope } : {}) })) authorization.searchParams.set(key, value);
      requests.set(id, { state, verifier, clientId, resource: target.href, tokenEndpoint: tokenEndpoint.href, status: 'pending', expires: Date.now() + 300000 });
      return { id, authorizationUrl: authorization.href, redirectUri: callbackURL };
    },
    async callback(url) {
      prune(); const state = url.searchParams.get('state');
      const request = [...requests.values()].find((r) => r.state === state && r.status === 'pending');
      if (!request) throw new Error('Invalid or expired OAuth state');
      request.status = 'exchanging';
      try {
        const error = url.searchParams.get('error'); if (error) throw new Error(`Authorization rejected: ${error}`);
        const code = url.searchParams.get('code'); if (!code) throw new Error('Authorization code missing');
        const token = await fetchJSON(request.tokenEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackURL, client_id: request.clientId, code_verifier: request.verifier, resource: request.resource }) });
        if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') throw new Error('Unsupported OAuth token response');
        request.result = { ...token, resource: request.resource, token_endpoint: request.tokenEndpoint, client_id: request.clientId, expires_at: token.expires_in ? Date.now() + Number(token.expires_in) * 1000 : null };
        delete request.verifier; request.status = 'complete';
      } catch (e) { request.status = 'failed'; request.error = e.message; throw e; }
    },
    status(id) { prune(); const request = requests.get(id); if (!request) throw new Error('Unknown or expired authorization'); return { status: request.status, error: request.error, token: request.result }; },
    forget(id) { requests.delete(id); },
  };
}
