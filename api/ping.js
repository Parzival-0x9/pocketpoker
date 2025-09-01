// api/ping.js - minimal function to confirm routing works
export const config = { runtime: 'edge' };

export default async function handler() {
  return new Response(JSON.stringify({ ok: true, pong: true, ts: new Date().toISOString() }), {
    headers: { 'content-type': 'application/json' }
  });
}
