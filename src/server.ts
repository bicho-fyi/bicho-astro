import { createClient, type Options } from '@bicho-fyi/javascript';
import type { MiddlewareHandler } from 'astro';

export type Connection = Pick<Options, 'endpoint' | 'key' | 'serviceName' | 'environment' | 'release'>;
export type ServerOptions = Connection & { closeTimeout?: number };

export async function reportError(error: unknown, options: ServerOptions): Promise<boolean> {
  let client;
  try {
    const timeout = options.closeTimeout ?? 2000;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 10000) return false;
    client = createClient({ ...options, autoCapture: false });
    const captured = client.captureException(error);
    const delivered = await client.close(timeout);
    return captured !== undefined && delivered;
  } catch {
    await client?.close(0);
    return false;
  }
}

export function createMiddleware(options: ServerOptions): MiddlewareHandler {
  return async (context, next) => {
    if (context.isPrerendered) return next();
    try {
      return await next();
    } catch (error) {
      await reportError(error, options);
      throw error;
    }
  };
}
