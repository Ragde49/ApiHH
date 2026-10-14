import { createHash, randomBytes } from "node:crypto";
const key = (token) => createHash("sha256").update(token).digest("hex");

export function createSessionStore(ttlMs, now = Date.now) {
  const entries = new Map();
  const prune = () => {
    for (const [id, session] of entries)
      if (session.expiresAt <= now()) entries.delete(id);
  };
  const timer = setInterval(prune, 60000);
  timer.unref();
  return {
    create(userId) {
      prune();
      if (entries.size >= 10000)
        throw new Error("Capacidad de sesiones agotada");
      const token = randomBytes(32).toString("base64url");
      entries.set(key(token), { userId, expiresAt: now() + ttlMs });
      return token;
    },
    get(token) {
      if (typeof token !== "string" || token.length !== 43) return null;
      const session = entries.get(key(token));
      if (!session) return null;
      if (session.expiresAt <= now()) {
        entries.delete(key(token));
        return null;
      }
      return session;
    },
    delete(token) {
      if (typeof token === "string") entries.delete(key(token));
    },
    close() {
      clearInterval(timer);
      entries.clear();
    },
  };
}
