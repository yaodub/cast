/**
 * Port resolution.
 *
 *   0         → OS assigns an ephemeral port
 *   specific  → use exactly that port, fail if unavailable
 */
import { createServer } from 'net';

/**
 * Resolve a port for binding.
 *   - 0: let the kernel assign an ephemeral port.
 *   - Any other value: verify the port is free, throw if not.
 */
export async function findAvailablePort(preferred: number, label: string): Promise<number> {
  if (preferred === 0) {
    return new Promise((resolve, reject) => {
      const srv = createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
    });
  }

  const available = await new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once('error', () => resolve(false));
    srv.listen(preferred, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });

  if (!available) {
    throw new Error(`[${label}] Port ${preferred} is already in use`);
  }
  return preferred;
}
