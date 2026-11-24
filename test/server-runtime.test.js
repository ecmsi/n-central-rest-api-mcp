import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  ContextError,
  authenticateRequest,
  createRateLimiter,
  getClientIp,
  parseRequestBody,
  resolveRequestContext,
  startHttpRuntime,
  validSessionId,
} from '../src/http-runtime.js';
import { makeContext } from '../src/context.js';
import { createMcpServer } from '../src/mcp-server.js';
import { inc, renderPrometheus, setGauge } from '../src/metrics.js';
import { createCapabilityResult } from '../src/tool-registry.js';
import { CURATED_OUTPUT_SCHEMA } from '../src/tools/core.js';

describe('focused server runtime modules', () => {
  it('keeps the executable entry point limited to configuration and lifecycle wiring', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    assert.ok(source.split('\n').length < 200);
    assert.doesNotMatch(source, /http\.createServer|registerTool|class ContextError/);
  });

  it('constructs the MCP registration boundary independently', () => {
    const server = createMcpServer([]);
    assert.equal(typeof server.connect, 'function');
    assert.equal(typeof server.registerTool, 'function');
  });

  it('enforces strict inputs and renders successful and failed handlers in memory', async () => {
    const inputSchema = {
      type: 'object', additionalProperties: false,
      properties: { value: { type: 'string' } }, required: ['value'],
    };
    const tools = [
      {
        name: 'synthetic_read', description: 'Synthetic successful read used by the runtime test.',
        inputSchema, outputSchema: CURATED_OUTPUT_SCHEMA,
        operations: ['GET /api/synthetic'], toolsets: ['core'], writeScope: 'read',
        handler: async ({ value }) => value === 'large-partial'
          ? createCapabilityResult(
            Array.from({ length: 400 }, (_, index) => ({ index, value: 'x'.repeat(1000) })),
            ['GET /api/synthetic'],
            [{ component: 'optional', code: 'NOT_FOUND', message: 'not found' }],
          )
          : createCapabilityResult({ value }, ['GET /api/synthetic']),
      },
      {
        name: 'synthetic_write', description: 'Synthetic failed write used by the runtime test.',
        inputSchema, outputSchema: CURATED_OUTPUT_SCHEMA,
        operations: ['POST /api/synthetic'], toolsets: ['operations'], writeScope: 'write',
        handler: async () => { throw new Error('Bearer secret at https://tenant.example.test/api'); },
      },
    ];
    const server = createMcpServer(tools);
    const client = new Client({ name: 'runtime-test', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const invalid = await client.callTool({
        name: 'synthetic_read', arguments: { value: 'ok', unexpected: true },
      });
      assert.equal(invalid.isError, true);

      const successful = await client.callTool({
        name: 'synthetic_read', arguments: { value: 'ok' },
      });
      assert.deepEqual(successful.structuredContent.data, { value: 'ok' });
      const [summaryLine, serialized] = successful.content[0].text.split('\n');
      assert.equal(summaryLine, 'Returned an object with fields: value.');
      assert.deepEqual(JSON.parse(serialized), successful.structuredContent);

      const failed = await client.callTool({
        name: 'synthetic_write', arguments: { value: 'fail' },
      });
      assert.equal(failed.isError, true);
      assert.equal(JSON.stringify(failed).includes('secret'), false);
      assert.equal(JSON.stringify(failed).includes('tenant.example.test'), false);
      const bounded = await client.callTool({
        name: 'synthetic_read', arguments: { value: 'large-partial' },
      });
      assert.equal(bounded.structuredContent.meta.partial, true);
      assert.equal(bounded.structuredContent.meta.truncated, true);
      const metrics = renderPrometheus();
      assert.match(metrics, /nc_mcp_tool_duration_ms_total\{success="true",tool="synthetic_read"\}/);
      assert.match(metrics, /nc_mcp_tool_response_bytes_total\{success="true",tool="synthetic_read"\}/);
      assert.match(metrics, /nc_mcp_upstream_operations_total\{tool="synthetic_read"\} 2/);
      assert.match(metrics, /nc_mcp_tool_response_bytes_total\{success="false",tool="synthetic_write"\}/);
      assert.match(metrics, /nc_mcp_partial_results_total\{tool="synthetic_read"\}/);
      assert.match(metrics, /nc_mcp_truncated_results_total\{tool="synthetic_read"\}/);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('renders summary-only text when the server is created with resultTextMode summary', async () => {
    const tools = [{
      name: 'synthetic_summary', description: 'Synthetic read used to verify summary mode.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} },
      outputSchema: CURATED_OUTPUT_SCHEMA,
      operations: ['GET /api/synthetic'], toolsets: ['core'], writeScope: 'read',
      handler: async () => createCapabilityResult({ value: 'hidden-from-text' }, ['GET /api/synthetic']),
    }];
    const server = createMcpServer(tools, { resultTextMode: 'summary' });
    const client = new Client({ name: 'runtime-test-summary', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: 'synthetic_summary', arguments: {} });
      assert.deepEqual(result.structuredContent.data, { value: 'hidden-from-text' });
      assert.equal(result.content[0].text, 'Returned an object with fields: value.');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('enforces rate limits, bounded client tracking, and window rollover deterministically', () => {
    let now = 1_000;
    const limiter = createRateLimiter({ windowMs: 100, maximum: 2, capacity: 2, now: () => now });
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), true);
    assert.equal(limiter.allow('a'), false);
    assert.equal(limiter.allow('b'), true);
    assert.equal(limiter.allow('c'), true);
    assert.equal(limiter.size(), 2);
    now += 101;
    assert.equal(limiter.allow('a'), true);
    now += 201;
    limiter.cleanup();
    assert.equal(limiter.size(), 0);
  });

  it('parses valid request bodies and rejects malformed or oversized JSON', async () => {
    const valid = Readable.from([Buffer.from('{"ok":true}')]);
    assert.deepEqual(await parseRequestBody(valid, 32), { ok: true });
    await assert.rejects(parseRequestBody(Readable.from(['{']), 32), /Invalid JSON body/);
    await assert.rejects(parseRequestBody(Readable.from(['12345']), 4), /too large/);
  });

  it('keeps single-tenant credentials authoritative and validates multi-tenant headers', () => {
    const envContext = { fqdn: 'https://fixed.example.test', jwt: 'fixed', key: 'fixed-key' };
    const overridden = resolveRequestContext({
      headers: { 'x-nc-fqdn': 'https://evil.example.test', 'x-nc-jwt': 'a.b.c' },
    }, { multiTenant: false, envContext, allowlist: [] });
    assert.equal(overridden, envContext);

    assert.throws(() => resolveRequestContext({ headers: {} }, {
      multiTenant: true,
      envContext: null,
      allowlist: ['allowed.example.test'],
    }), ContextError);

    const context = resolveRequestContext({
      headers: { 'x-nc-fqdn': 'https://api.allowed.example.test', 'x-nc-jwt': 'a.b.c' },
    }, { multiTenant: true, envContext: null, allowlist: ['allowed.example.test'] });
    assert.equal(context.fqdn, 'https://api.allowed.example.test');
  });

  it('validates sessions, bearer authentication, and trusted proxy addresses', () => {
    assert.equal(validSessionId('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(validSessionId('not-a-session'), false);
    const req = {
      headers: { authorization: 'Bearer expected', 'x-forwarded-for': '192.0.2.1, 192.0.2.2' },
      socket: { remoteAddress: '127.0.0.1' },
    };
    assert.equal(authenticateRequest(req, 'expected'), true);
    assert.equal(authenticateRequest(req, 'wrong'), false);
    assert.equal(getClientIp(req, true), '192.0.2.1');
    assert.equal(getClientIp(req, false), '127.0.0.1');
  });

  it('renders deterministic escaped metrics for runtime counters and gauges', () => {
    inc('runtime_test_total', { z: 'quoted"value', a: 1 }, 2);
    setGauge('runtime_test_gauge', 3);
    const output = renderPrometheus();
    assert.match(output, /# TYPE runtime_test_total counter/);
    assert.match(output, /runtime_test_total\{a="1",z="quoted\\"value"\} 2/);
    assert.match(output, /# TYPE runtime_test_gauge gauge\nruntime_test_gauge 3/);
  });
});

describe('HTTP session routing', () => {
  const UNKNOWN_SESSION = '123e4567-e89b-12d3-a456-426614174000';
  const INITIALIZE = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
  };
  const TOOLS_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

  async function withRuntime(callback) {
    const runtime = await startHttpRuntime({
      port: 0, bindAddress: '127.0.0.1', apiKey: 'runtime-key', corsOrigin: '', trustProxy: false,
      maxBodySize: 65_536, rateLimitWindowMs: 60_000, rateLimitMaximum: 1_000, maxRateLimitEntries: 100,
      maxSessions: 10, sessionTtlMs: 60_000, metricsRequireAuth: false, multiTenant: false,
      envContext: makeContext('https://runtime.example.test', 'a.b.c'), fqdnAllowlist: [],
      createServer: () => createMcpServer([]),
    });
    const audit = [];
    const originalError = console.error;
    console.error = (message) => { audit.push(String(message)); };
    try {
      await callback({ port: runtime.httpServer.address().port, audit, runtime });
    } finally {
      console.error = originalError;
      await runtime.shutdown();
    }
  }

  function request(port, method, { sessionId, body } = {}) {
    return fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        Authorization: 'Bearer runtime-key',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }

  async function expectSessionNotFound(response) {
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), {
      jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null,
    });
  }

  it('answers a well-formed but unknown session id with 404 on POST, GET, and DELETE', async () => {
    await withRuntime(async ({ port, audit }) => {
      await expectSessionNotFound(await request(port, 'POST', { sessionId: UNKNOWN_SESSION, body: TOOLS_LIST }));
      await expectSessionNotFound(await request(port, 'GET', { sessionId: UNKNOWN_SESSION }));
      await expectSessionNotFound(await request(port, 'DELETE', { sessionId: UNKNOWN_SESSION }));
      const entries = audit.filter((line) => line.includes('"event":"session_not_found"'));
      assert.equal(entries.length, 3);
      for (const entry of entries) assert.doesNotMatch(entry, new RegExp(UNKNOWN_SESSION));
    });
  });

  it('keeps 400 for a non-initialize POST without a session and for a malformed session id', async () => {
    await withRuntime(async ({ port, audit }) => {
      const missing = await request(port, 'POST', { body: TOOLS_LIST });
      assert.equal(missing.status, 400);
      assert.deepEqual(await missing.json(), {
        jsonrpc: '2.0', error: { code: -32000, message: 'Bad request: missing session' }, id: null,
      });
      const malformed = await request(port, 'POST', { sessionId: 'not-a-session', body: TOOLS_LIST });
      assert.equal(malformed.status, 400);
      await malformed.text();
      for (const method of ['GET', 'DELETE']) {
        const malformedStream = await request(port, method, { sessionId: 'not-a-session' });
        assert.equal(malformedStream.status, 400, method);
        assert.equal(await malformedStream.text(), 'Invalid session');
        const absent = await request(port, method);
        assert.equal(absent.status, 400, method);
        await absent.text();
      }
      assert.equal(audit.some((line) => line.includes('session_not_found')), false);
    });
  });

  it('still creates a session for an initialize request without a session id and 404s it once deleted', async () => {
    await withRuntime(async ({ port, runtime }) => {
      const initialized = await request(port, 'POST', { body: INITIALIZE });
      assert.equal(initialized.status, 200);
      const sessionId = initialized.headers.get('mcp-session-id');
      assert.equal(validSessionId(sessionId), true);
      await initialized.text();
      assert.equal(runtime.sessionCount(), 1);

      const deleted = await request(port, 'DELETE', { sessionId });
      assert.equal(deleted.status, 200);
      await deleted.text();
      assert.equal(runtime.sessionCount(), 0);
      await expectSessionNotFound(await request(port, 'POST', { sessionId, body: TOOLS_LIST }));
    });
  });
});
