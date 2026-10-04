export async function timedFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) {
    if (controller.signal.aborted) throw new Error('Backend connection timed out. Check the server address, Wi-Fi and that the laptop backend is running.');
    throw error;
  }
  finally { clearTimeout(timer); }
}
