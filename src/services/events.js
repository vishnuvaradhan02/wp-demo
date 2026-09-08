/** Tiny server-sent-events hub so the dashboard updates live. */
const clients = new Set();

export function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function emit(type, payload = {}) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    try { res.write(frame); } catch { clients.delete(res); }
  }
}

export function clientCount() { return clients.size; }
