import type { Config } from '../config.js';
import type { BridgeRoutes, BridgeSession, RequestSpec, WithSessionOptions } from '../deps.js';
import { logDebug } from '../log.js';
import { readBridgeConfig, type BridgeHandshake } from './configFile.js';
import { bridgeRequest } from './httpClient.js';
import { createRoutes } from './routes.js';
import { BridgeHttpError, isUnauthorized } from './errors.js';

const MUTATED_HINT =
  'Part of the change may already have been applied; check the current state before retrying.';

/**
 * Runs `fn` against a session with `{port, token}` pinned once, so a fan-out of
 * reads can never be stitched together from two different app instances.
 *
 * A 401 means the app rotated its token: the session cancels whatever else is in
 * flight, re-reads the handshake — which also picks up a new port after a restart
 * — and replays `fn` exactly once. Nothing else is ever retried: a bridge that
 * dropped the socket mid-POST may well have committed the write.
 */
export async function withBridgeSession<T>(
  config: Config,
  options: WithSessionOptions,
  fn: (routes: BridgeRoutes, session: BridgeSession) => Promise<T>,
): Promise<T> {
  let handshake: BridgeHandshake = await readBridgeConfig(config.bridgeConfigPath);
  let attempt = 1;
  let mutationCommitted = false;

  for (;;) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const pinned = handshake;

    const session: BridgeSession = {
      host: pinned.host,
      port: pinned.port,
      attempt,
      signal,
      get mutationCommitted() {
        return mutationCommitted;
      },
      async request<R>(spec: RequestSpec): Promise<R> {
        const result = await bridgeRequest<R>(spec, {
          host: pinned.host,
          port: pinned.port,
          token: pinned.token,
          timeoutMs: config.timeoutMs,
          maxRequestBytes: config.maxRequestBytes,
          maxResponseBytes: config.maxResponseBytes,
          signal,
        });
        if (spec.mutating === true) mutationCommitted = true;
        return result;
      },
    };

    // The port tells which app instance answered when several are running.
    logDebug('bridge session', { port: pinned.port, attempt });

    try {
      return await fn(createRoutes(session), session);
    } catch (err) {
      if (isUnauthorized(err) && mutationCommitted) {
        throw new BridgeHttpError(
          {
            status: err.status,
            kind: 'unauthorized',
            message: 'the bridge token was rotated after a change had already been written',
            upstreamCode: err.upstreamCode,
            upstreamMessage: err.upstreamMessage,
          },
          { hint: MUTATED_HINT, cause: err },
        );
      }
      if (isUnauthorized(err) && attempt === 1) {
        controller.abort();
        handshake = await readBridgeConfig(config.bridgeConfigPath);
        attempt = 2;
        continue;
      }
      throw err;
    } finally {
      controller.abort();
    }
  }
}
