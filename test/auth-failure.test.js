/**
 * A failed JWT exchange must surface only the HTTP status. The upstream
 * response body is N-central's own error text and can name the server or
 * user, and the thrown message lands in MCP client log files.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { als, makeContext } from '../src/context.js';
import { apiGet } from '../src/client.js';
import { evictTenant } from '../src/auth.js';

const ctx = makeContext('https://failing.example.com', 'jwtFail');
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  evictTenant(ctx.key);
});

describe('auth failure reporting', () => {
  it('reports only the status code and never the upstream body', async () => {
    const secretBody = 'tenant-identifying detail: user bob@failing.example.com is locked';
    let authCalls = 0;
    global.fetch = async (url, init = {}) => {
      const u = new URL(typeof url === 'string' ? url : url.url);
      assert.equal(init.redirect, 'error', 'auth fetch refuses redirects');
      if (u.pathname === '/api/auth/authenticate') {
        authCalls += 1;
        return new Response(secretBody, { status: 401, headers: { 'Content-Type': 'text/plain' } });
      }
      throw new Error(`unexpected data call before authentication: ${u.pathname}`);
    };

    await assert.rejects(
      () => als.run(ctx, () => apiGet('/api/health')),
      (error) => {
        assert.equal(error.message, 'Auth failed (401)');
        assert.equal(error.message.includes('bob'), false);
        assert.equal(error.message.includes('locked'), false);
        return true;
      },
    );
    assert.equal(authCalls, 1, 'a rejected exchange is not retried in a loop');
  });
});
