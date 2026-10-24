import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import net from 'node:net';

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('server smoke test without provider credentials or database', async t => {
  const port = await freePort();
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', OPENROUTER_API_KEY: '', OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DATABASE_URL: '' },
    stdio: 'ignore'
  });
  t.after(() => { if (!child.killed) child.kill('SIGTERM'); });

  let base = `http://127.0.0.1:${port}`;
  let response;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited early with code ${child.exitCode}`);
    try { response = await fetch(`${base}/api/health`); break; }
    catch { await delay(150); }
  }
  assert.ok(response, 'server should start and respond');
  assert.equal(response.status, 200);
  const health = await response.json();
  assert.equal(health.ok, true);

  response = await fetch(`${base}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/html/);
  assert.match(await response.text(), /<html/i);

  for (const path of ['/api/conversations', '/api/projects', '/api/prompts']) {
    response = await fetch(`${base}${path}`);
    assert.equal(response.status, 200, `${path} should respond successfully`);
    assert.ok(Array.isArray(await response.json()), `${path} should return a JSON array`);
  }

  response = await fetch(`${base}/api/route-that-does-not-exist`);
  assert.equal(response.status, 404);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
});
