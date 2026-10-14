import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync } from "node:crypto";
import { createApp } from "../src/app.js";
import { createSessionStore } from "../src/modules/auth/sessions.js";
import { verifyPassword } from "../src/modules/auth/password.js";

const salt = Buffer.alloc(32, 7);
function user(overrides = {}) {
  return {
    UsuarioId: 1,
    Usuario: "test",
    NombreCompleto: "Usuario de prueba",
    Email: null,
    PasswordAlgorithm: "PBKDF2-HMAC-SHA256",
    PasswordIterations: 150000,
    PasswordSalt: salt,
    PasswordHash: pbkdf2Sync("correct-password", salt, 150000, 32, "sha256"),
    Activo: true,
    Bloqueado: false,
    RequiereCambioPassword: false,
    ...overrides,
  };
}
async function fixture(t, record = user(), limit = 100) {
  const sessions = createSessionStore(60000);
  const users = {
    findByUsername: async (name) => (name === "test" ? record : null),
    findById: async (id) => (id === record?.UsuarioId ? record : null),
    updatePassword: async (id, passwordRecord) => {
      if (
        id !== record?.UsuarioId ||
        !record.Activo ||
        record.Bloqueado ||
        !record.RequiereCambioPassword
      ) {
        return false;
      }
      Object.assign(record, passwordRecord, {
        RequiereCambioPassword: false,
      });
      return true;
    },
  };
  const deliveries = {
    summary: async (userId) => ({
      assignedAmount: userId === record?.UsuarioId ? 50000 : 0,
      deliveredAmount: 0,
      returnAmount: userId === record?.UsuarioId ? 50000 : 0,
      totalDeliveries: userId === record?.UsuarioId ? 2 : 0,
      pendingDeliveries: userId === record?.UsuarioId ? 2 : 0,
      completedDeliveries: 0,
      issueDeliveries: 0,
    }),
    today: async (userId) =>
      userId === record?.UsuarioId
        ? [
            {
              id: "1",
              clientName: "Cliente prueba",
              scheduledAmount: 50000,
              status: "PENDIENTE",
            },
          ]
        : [],
    history: async () => [],
    detail: async (userId, deliveryId) =>
      userId === record?.UsuarioId && deliveryId === "1"
        ? {
            id: "1",
            assignmentId: "1",
            clientId: "191394",
            clientName: "Cliente prueba",
            clientRfc: null,
            scheduledAmount: 50000,
            deliveredAmount: 50000,
            returnAmount: 0,
            receiverName: "Cliente",
            status: "ENTREGADA",
            issueReason: null,
            observations: "Sin novedad",
            createdAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            eventAt: null,
            signature: {
              mimeType: "image/png",
              base64: Buffer.from("firma").toString("base64"),
              hashSha256: "00",
            },
            video: {
              id: "7f09826e-2a91-49da-a849-6f880ea42317",
              extension: ".mp4",
              mimeType: "video/mp4",
              sizeBytes: 1024,
              hashSha256: "11",
            },
          }
        : null,
    complete: async () => ({ ok: true }),
    reportIssue: async () => true,
  };
  const config = {
    origin: "http://localhost:8081",
    cookieSecure: false,
    sessionTtlMs: 60000,
    trustProxyHops: 0,
  };
  const app = createApp({
    config,
    users,
    deliveries,
    sessions,
    loginLimit: limit,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    sessions.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const request = (path, options) =>
    fetch(`http://127.0.0.1:${server.address().port}/api${path}`, options);
  const login = (
    body = { username: "test", password: "correct-password" },
    headers = {},
  ) =>
    request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  return { request, login, users, deliveries };
}

test("login sets HttpOnly cookie, restores session, rotates and revokes it", async (t) => {
  const { login, request } = await fixture(t);
  const result = await login();
  assert.equal(result.status, 200);
  const body = await result.json();
  assert.deepEqual(
    Object.keys(body.user).sort(),
    ["email", "id", "name", "requiresPasswordChange", "username"].sort(),
  );
  const setCookie = result.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  const cookie = setCookie.split(";")[0];
  assert.equal(
    (await request("/auth/me", { headers: { cookie } })).status,
    200,
  );
  const rotated = await login(undefined, { cookie });
  const newCookie = rotated.headers.get("set-cookie").split(";")[0];
  assert.notEqual(newCookie, cookie);
  assert.equal(
    (await request("/auth/me", { headers: { cookie } })).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/logout", {
        method: "POST",
        headers: { cookie: newCookie },
      })
    ).status,
    204,
  );
  assert.equal(
    (await request("/auth/me", { headers: { cookie: newCookie } })).status,
    401,
  );
});

test("wrong password, unknown user, inactive and blocked users are denied uniformly", async (t) => {
  for (const [record, credentials] of [
    [user(), { username: "test", password: "wrong" }],
    [user(), { username: "' OR 1=1 --", password: "correct-password" }],
    [user({ Activo: false }), undefined],
    [user({ Bloqueado: true }), undefined],
  ]) {
    const { login } = await fixture(t, record);
    const response = await login(credentials);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(
      (await response.json()).message,
      "Usuario o contraseña incorrectos, o cuenta no disponible.",
    );
  }
});

test("required password change grants no session", async (t) => {
  const { login } = await fixture(t, user({ RequiereCambioPassword: true }));
  const response = await login();
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("required password change can update password and create native session", async (t) => {
  const record = user({ RequiereCambioPassword: true });
  const { login, request } = await fixture(t, record);
  const blocked = await login(undefined, { "X-Client": "hh-app" });
  assert.equal(blocked.status, 403);
  const changed = await request("/auth/change-password", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Client": "hh-app",
    },
    body: JSON.stringify({
      username: "test",
      currentPassword: "correct-password",
      newPassword: "next-password",
    }),
  });
  assert.equal(changed.status, 200);
  assert.equal(record.RequiereCambioPassword, false);
  assert.equal(await verifyPassword("next-password", record), true);
  assert.equal(await verifyPassword("correct-password", record), false);
  const { user: bodyUser, token } = await changed.json();
  assert.equal(bodyUser.requiresPasswordChange, false);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    (await request("/auth/me", { headers: { Authorization: `Bearer ${token}` } }))
      .status,
    200,
  );
});

test("required password change validates current and new password", async (t) => {
  const { request } = await fixture(t, user({ RequiereCambioPassword: true }));
  assert.equal(
    (
      await request("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "test",
          currentPassword: "wrong",
          newPassword: "next-password",
        }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request("/auth/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "test",
          currentPassword: "correct-password",
          newPassword: "short",
        }),
      })
    ).status,
    400,
  );
});

test("blocked account revokes an existing session on next request", async (t) => {
  const record = user();
  const { login, request } = await fixture(t, record);
  const response = await login();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  record.Bloqueado = true;
  assert.equal(
    (await request("/auth/me", { headers: { cookie } })).status,
    401,
  );
  record.Bloqueado = false;
  assert.equal(
    (await request("/auth/me", { headers: { cookie } })).status,
    401,
  );
});

test("invalid bodies, cross-origin requests and unauthenticated requests are denied", async (t) => {
  const { login, request } = await fixture(t);
  for (const body of [
    {},
    { username: {}, password: "x" },
    { username: "x", password: [] },
    { username: "x", password: "x".repeat(1025) },
  ]) {
    assert.equal((await login(body)).status, 400);
  }
  assert.equal(
    (await login(undefined, { Origin: "https://untrusted.example" })).status,
    403,
  );
  assert.equal((await request("/auth/me")).status, 401);
  assert.equal(
    (
      await request("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      })
    ).status,
    400,
  );
});

test("login rate limiter blocks repeated attempts", async (t) => {
  const { login } = await fixture(t, user(), 2);
  await login({ username: "test", password: "bad" });
  await login({ username: "test", password: "bad" });
  assert.equal((await login()).status, 429);
});

test("database failure returns controlled service error", async (t) => {
  const { login, users } = await fixture(t);
  users.findByUsername = async () => {
    throw Object.assign(new Error("private detail"), { code: "ETEST" });
  };
  const response = await login();
  assert.equal(response.status, 503);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private detail/);
});

test("password validation rejects unsupported algorithm and malformed metadata", async () => {
  assert.equal(await verifyPassword("correct-password", user()), true);
  assert.equal(
    await verifyPassword(
      "correct-password",
      user({ PasswordAlgorithm: "unknown" }),
    ),
    false,
  );
  assert.equal(
    await verifyPassword("correct-password", user({ PasswordIterations: 0 })),
    false,
  );
});

test("session expires at its deadline and cannot be reused", () => {
  let now = 100;
  const sessions = createSessionStore(50, () => now);
  const token = sessions.create(1);
  assert.equal(sessions.get(token).userId, 1);
  now = 150;
  assert.equal(sessions.get(token), null);
  sessions.close();
});

test("native login returns a bearer token, rotates it and revokes it on logout", async (t) => {
  const { login, request } = await fixture(t);
  const response = await login(undefined, { "X-Client": "hh-app" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  const { token, expiresIn } = await response.json();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(expiresIn, 60);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await request("/auth/me", { headers })).status, 200);
  const rotated = await login(undefined, { ...headers, "X-Client": "hh-app" });
  const next = (await rotated.json()).token;
  assert.notEqual(next, token);
  assert.equal((await request("/auth/me", { headers })).status, 401);
  const nextHeaders = { Authorization: `Bearer ${next}` };
  assert.equal(
    (await request("/auth/me", { headers: nextHeaders })).status,
    200,
  );
  assert.equal(
    (await request("/auth/logout", { method: "POST", headers: nextHeaders }))
      .status,
    204,
  );
  assert.equal(
    (await request("/auth/me", { headers: nextHeaders })).status,
    401,
  );
});

test("mobile summary returns route and cut data for bearer session", async (t) => {
  const { login, request } = await fixture(t);
  const response = await login(undefined, { "X-Client": "hh-app" });
  const { token } = await response.json();
  const summary = await request("/mobile/summary", {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(summary.status, 200);
  const body = await summary.json();
  assert.equal(body.summary.assignedAmount, 50000);
  assert.equal(body.summary.pendingDeliveries, 2);
  assert.equal(body.pending[0].clientName, "Cliente prueba");
  assert.equal(body.today[0].clientName, "Cliente prueba");
});

test("delivery completion requires signature and video evidence", async (t) => {
  const { login, request } = await fixture(t);
  const response = await login(undefined, { "X-Client": "hh-app" });
  const { token } = await response.json();
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  assert.equal(
    (
      await request("/deliveries/1/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({
          amountDelivered: 50000,
          receiverName: "Cliente",
          idempotencyKey: "7f09826e-2a91-49da-a849-6f880ea42317",
        }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request("/deliveries/1/complete", {
        method: "POST",
        headers,
        body: JSON.stringify({
          amountDelivered: 50000,
          receiverName: "Cliente",
          signatureStrokes: [
            [
              { x: 0.1, y: 0.5 },
              { x: 0.8, y: 0.5 },
            ],
          ],
          videoBase64: Buffer.alloc(1024).toString("base64"),
          videoMimeType: "video/mp4",
          videoSizeBytes: 1024,
          idempotencyKey: "7f09826e-2a91-49da-a849-6f880ea42317",
        }),
      })
    ).status,
    201,
  );
});

test("invalid bearer token does not fall back to a valid browser cookie", async (t) => {
  const { login, request } = await fixture(t);
  const response = await login();
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await request("/auth/me", {
        headers: { cookie, Authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
});

test("native login also enforces mandatory password change", async (t) => {
  const { login } = await fixture(t, user({ RequiereCambioPassword: true }));
  const response = await login(undefined, { "X-Client": "hh-app" });
  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.code, "PASSWORD_CHANGE_REQUIRED");
  assert.equal(body.token, undefined);
});
