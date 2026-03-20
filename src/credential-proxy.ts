/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API or Forgejo.
 * The proxy injects real credentials so containers never see them.
 *
 * Routes:
 *   /git-credentials      → Git credential helper endpoint (returns Forgejo token)
 *   /forgejo/*            → Forgejo API (strips prefix, injects token)
 *   everything else       → Anthropic API
 *
 * Anthropic auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'FORGEJO_URL',
    'FORGEJO_TOKEN',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      // Handle /git-credentials endpoint for git credential helper
      if (req.url === '/git-credentials' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const payload = JSON.parse(body);

            if (!secrets.FORGEJO_URL || !secrets.FORGEJO_TOKEN) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'FORGEJO_URL and FORGEJO_TOKEN must be configured',
                }),
              );
              return;
            }

            // Extract hostname from FORGEJO_URL to validate request
            const forgejoUrl = new URL(secrets.FORGEJO_URL);
            const forgejoHost = forgejoUrl.hostname;
            const requestedHost = payload.host;

            // For localhost/127.0.0.1, containers use host.docker.internal
            const validHosts = [forgejoHost];
            if (forgejoHost === 'localhost' || forgejoHost === '127.0.0.1') {
              validHosts.push('host.docker.internal');
            }

            // Only return credentials if the requested host matches Forgejo
            if (validHosts.includes(requestedHost)) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  username: 'x-token-auth',
                  password: secrets.FORGEJO_TOKEN,
                }),
              );
            } else {
              // Don't leak credentials to other hosts
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({}));
            }
          } catch (err) {
            logger.error({ err }, 'Error handling /git-credentials request');
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid request' }));
          }
        });
        return;
      }

      // Determine route type
      const isForgejoRoute = req.url?.startsWith('/forgejo/');

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);

        if (isForgejoRoute) {
          // Forgejo route
          if (!secrets.FORGEJO_URL || !secrets.FORGEJO_TOKEN) {
            logger.error(
              'Forgejo route requested but FORGEJO_URL/FORGEJO_TOKEN not configured',
            );
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('FORGEJO_URL and FORGEJO_TOKEN must be configured in .env');
            return;
          }

          // Strip /forgejo prefix from path
          const forgejoPath = req.url!.slice('/forgejo'.length) || '/';
          const forgejoUrl = new URL(secrets.FORGEJO_URL);
          const forgejoIsHttps = forgejoUrl.protocol === 'https:';
          const forgejoMakeRequest = forgejoIsHttps
            ? httpsRequest
            : httpRequest;

          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: forgejoUrl.host,
            'content-length': body.length,
          };

          // Strip hop-by-hop headers
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          // Inject Forgejo token
          headers['authorization'] = `token ${secrets.FORGEJO_TOKEN}`;

          const upstream = forgejoMakeRequest(
            {
              hostname: forgejoUrl.hostname,
              port: forgejoUrl.port || (forgejoIsHttps ? 443 : 80),
              path: forgejoPath,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url, forgejoPath },
              'Credential proxy Forgejo upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway - Forgejo upstream error');
            }
          });

          upstream.write(body);
          upstream.end();
        } else {
          // Anthropic route (existing behavior)
          const headers: Record<
            string,
            string | number | string[] | undefined
          > = {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

          // Strip hop-by-hop headers that must not be forwarded by proxies
          delete headers['connection'];
          delete headers['keep-alive'];
          delete headers['transfer-encoding'];

          if (authMode === 'api-key') {
            // API key mode: inject x-api-key on every request
            delete headers['x-api-key'];
            headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
          } else {
            // OAuth mode: replace placeholder Bearer token with the real one
            // only when the container actually sends an Authorization header
            // (exchange request + auth probes). Post-exchange requests use
            // x-api-key only, so they pass through without token injection.
            if (headers['authorization']) {
              delete headers['authorization'];
              if (oauthToken) {
                headers['authorization'] = `Bearer ${oauthToken}`;
              }
            }
          }

          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err) => {
            logger.error(
              { err, url: req.url },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        }
      });
    });

    server.listen(port, host, () => {
      logger.info({ port, host, authMode }, 'Credential proxy started');
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
