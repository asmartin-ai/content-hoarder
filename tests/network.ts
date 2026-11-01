export const OFFLINE_KEY = "CONTENT_HOARDER_OFFLINE";

export function goOffline(): void {
  process.env[OFFLINE_KEY] = "1";
}

export async function withOnline(fn: () => Promise<void> | void): Promise<void> {
  process.env[OFFLINE_KEY] = "";

  try {
    await fn();
  } finally {
    goOffline();
  }
}
