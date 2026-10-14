export function loadConfig(env = process.env) {
  const required = (name) => {
    if (!env[name]) throw new Error(`Falta configurar ${name}`);
    return env[name];
  };
  const integer = (name, fallback, min, max) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max)
      throw new Error(`Configuración inválida: ${name}`);
    return value;
  };
  const bool = (name, fallback) => {
    const value = env[name] ?? String(fallback);
    if (!["true", "false"].includes(value))
      throw new Error(`Configuración inválida: ${name}`);
    return value === "true";
  };
  const production = env.NODE_ENV === "production";
  const origin = required("FRONTEND_ORIGIN");
  if (new URL(origin).origin !== origin)
    throw new Error("FRONTEND_ORIGIN debe contener solo el origen");
  const cookieSecure = bool("COOKIE_SECURE", production);
  if (production && (!cookieSecure || !origin.startsWith("https://")))
    throw new Error("Producción requiere HTTPS y COOKIE_SECURE=true");
  return {
    port: integer("PORT", 3001, 1, 65535),
    origin,
    cookieSecure,
    trustProxyHops: integer("TRUST_PROXY_HOPS", 0, 0, 5),
    sessionTtlMs: integer("SESSION_TTL_MINUTES", 480, 1, 1440) * 60_000,
    db: {
      server: required("DB_SERVER"),
      port: integer("DB_PORT", 1433, 1, 65535),
      database: required("DB_NAME"),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      connectionTimeout: 15000,
      requestTimeout: 15000,
      pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
      options: {
        encrypt: bool("DB_ENCRYPT", true),
        trustServerCertificate: bool("DB_TRUST_SERVER_CERTIFICATE", false),
      },
    },
  };
}
