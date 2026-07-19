import { describe, it } from 'node:test';
import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { GenericContainer, Network, Wait } from 'testcontainers';
import { fetchurl, hashData } from './fetchurl.js';

/** Best-effort stop: one failure must not skip remaining cleanup. */
async function stopQuietly(resource, label) {
  if (!resource) return;
  try {
    await resource.stop();
  } catch (err) {
    console.error(`failed to stop ${label}:`, err);
  }
}

describe('fetchurl integration (testcontainers)', { timeout: 120_000 }, () => {
  it('fetches through fetchurl server from a source URL', async () => {
    const imageRef = process.env.FETCHURL_TEST_IMAGE;
    if (!imageRef) {
      // This repo has no Dockerfile; the reference server image is external
      // (same contract as fetchurl/sdk-python). CI only runs this when the var is set.
      throw new Error(
        'FETCHURL_TEST_IMAGE is required for integration tests (e.g. fetchurl:local)',
      );
    }

    const content = Buffer.from('integration-test');
    const hash = await hashData('sha256', content);

    const network = await new Network().start();

    let container;
    const oldEnv = process.env.FETCHURL_SERVER;
    let upstream;
    try {
      // Network alias "upstream" is how the fetchurl server reaches the origin
      // (parity with sdk-python). Avoid container getIpAddress — fragile across
      // rootless Docker / podman network backends.
      upstream = await new GenericContainer('python:3.12-alpine')
        .withNetwork(network)
        .withNetworkAliases('upstream')
        .withCopyContentToContainer([
          { content: content.toString('utf8'), target: '/srv/file' },
        ])
        .withExposedPorts(8000)
        .withCommand([
          'python',
          '-m',
          'http.server',
          '8000',
          '--bind',
          '0.0.0.0',
          '--directory',
          '/srv',
        ])
        .withWaitStrategy(Wait.forHttp('/file', 8000))
        .start();

      // Spec readiness: /api/fetchurl/health returns 200 when the server can
      // serve. Prefer that over matching slog text ("Starting server …"), which
      // is an implementation detail and can drift without a behavior change.
      container = await new GenericContainer(imageRef)
        .withCommand(['server'])
        .withNetwork(network)
        .withExposedPorts(8080)
        .withEnvironment({ FETCHURL_ALLOW_PRIVATE_IPS: '1' })
        .withWaitStrategy(Wait.forHttp('/api/fetchurl/health', 8080))
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(8080);
      process.env.FETCHURL_SERVER = `"http://${host}:${port}/api/fetchurl"`;

      const sourceUrl = 'http://upstream:8000/file';
      const data = await fetchurl({
        fetch,
        algo: 'sha256',
        hash,
        sourceUrls: [sourceUrl],
      });

      assert.deepEqual(data, new Uint8Array(content));
    } finally {
      if (oldEnv === undefined) delete process.env.FETCHURL_SERVER;
      else process.env.FETCHURL_SERVER = oldEnv;
      await stopQuietly(container, 'fetchurl container');
      await stopQuietly(upstream, 'upstream container');
      await stopQuietly(network, 'docker network');
    }
  });
});
