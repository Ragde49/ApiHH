import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { hashPassword, verifyPassword } from "./modules/auth/password.js";
import { hasSignature } from "./modules/deliveries/signature.js";

const publicUser = (user) => ({
  id: user.UsuarioId,
  username: user.Usuario,
  name: user.NombreCompleto,
  email: user.Email,
  requiresPasswordChange: Boolean(user.RequiereCambioPassword),
});
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deliveryIdPattern = /^\d{1,19}$/;
const videoMimeTypes = new Set(["video/mp4", "video/quicktime"]);

export function createApp({
  config,
  users,
  deliveries,
  sessions,
  loginLimit = 10,
}) {
  const app = express();
  app.disable("x-powered-by");
  if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);
  app.use(helmet());
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.get("Origin");
    if (origin && origin !== config.origin)
      return res.status(403).json({ message: "Origen no permitido." });
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.get("Sec-Fetch-Site") === "cross-site"
    ) {
      return res.status(403).json({ message: "Origen no permitido." });
    }
    next();
  });
  app.use(cors({ origin: config.origin, credentials: true }));
  app.use(express.json({ limit: "35mb" }));
  app.use(cookieParser());
  const cookieName = config.cookieSecure ? "__Host-hh_session" : "hh_session";
  const cookieOptions = {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
  };
  const requestToken = (req) => {
    const authorization = req.get("Authorization");
    // An invalid explicit token must never fall back to a browser cookie.
    if (authorization !== undefined)
      return /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization)?.[1];
    return req.cookies[cookieName];
  };
  const requireUser = async (req, res, next) => {
    try {
      const token = requestToken(req);
      const session = sessions.get(token);
      if (!session)
        return res
          .status(401)
          .json({ message: "Inicia sesión para continuar." });
      const user = await users.findById(session.userId);
      if (!user?.Activo || user.Bloqueado || user.RequiereCambioPassword) {
        sessions.delete(token);
        res.clearCookie(cookieName, cookieOptions);
        return res.status(401).json({
          message: "La sesión ya no está disponible. Inicia sesión nuevamente.",
        });
      }
      req.authUser = user;
      req.authToken = token;
      next();
    } catch (error) {
      next(error);
    }
  };
  const validateDeliveryId = (req, res, next) => {
    if (!deliveryIdPattern.test(req.params.id))
      return res.status(404).json({ message: "Entrega no encontrada." });
    next();
  };
  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));
  const loginLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: loginLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      message: "Demasiados intentos. Intenta de nuevo en 15 minutos.",
    },
  });
  app.post("/api/auth/login", loginLimiter, async (req, res) => {
    const { username, password } = req.body ?? {};
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.trim().length > 100 ||
      typeof password !== "string" ||
      !password ||
      password.length > 1024
    ) {
      return res
        .status(400)
        .json({ message: "Ingresa un usuario y una contraseña válidos." });
    }
    const user = await users.findByUsername(username.trim());
    const valid = await verifyPassword(password, user);
    if (!valid || !user?.Activo || user.Bloqueado) {
      return res.status(401).json({
        message: "Usuario o contraseña incorrectos, o cuenta no disponible.",
      });
    }
    // Do not grant a normal session to an account that must change its password.
    if (user.RequiereCambioPassword) {
      return res.status(403).json({
        code: "PASSWORD_CHANGE_REQUIRED",
        message:
          "Debes cambiar tu contraseña para continuar.",
      });
    }
    sessions.delete(requestToken(req));
    const token = sessions.create(user.UsuarioId);
    if (req.get("X-Client") === "hh-app") {
      return res.json({
        user: publicUser(user),
        token,
        expiresIn: config.sessionTtlMs / 1000,
      });
    }
    res.cookie(cookieName, token, {
      ...cookieOptions,
      maxAge: config.sessionTtlMs,
    });
    res.json({ user: publicUser(user) });
  });
  app.post("/api/auth/change-password", loginLimiter, async (req, res) => {
    const { username, currentPassword, newPassword } = req.body ?? {};
    if (
      typeof username !== "string" ||
      !username.trim() ||
      username.trim().length > 100 ||
      typeof currentPassword !== "string" ||
      !currentPassword ||
      currentPassword.length > 1024 ||
      typeof newPassword !== "string" ||
      newPassword.length < 8 ||
      newPassword.length > 128
    ) {
      return res.status(400).json({
        message:
          "Ingresa el usuario, la contraseña actual y una contraseña nueva de al menos 8 caracteres.",
      });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({
        message: "La contraseña nueva debe ser diferente a la actual.",
      });
    }
    const user = await users.findByUsername(username.trim());
    const valid = await verifyPassword(currentPassword, user);
    if (!valid || !user?.Activo || user.Bloqueado) {
      return res.status(401).json({
        message: "Usuario o contraseña incorrectos, o cuenta no disponible.",
      });
    }
    if (!user.RequiereCambioPassword) {
      return res.status(409).json({
        message: "La cuenta no requiere cambio de contraseña.",
      });
    }
    const updated = await users.updatePassword(
      user.UsuarioId,
      await hashPassword(newPassword),
    );
    if (!updated) {
      return res.status(409).json({
        message: "No pudimos actualizar la contraseña. Intenta nuevamente.",
      });
    }
    sessions.delete(requestToken(req));
    const refreshed =
      (await users.findById(user.UsuarioId)) ?? {
        ...user,
        RequiereCambioPassword: false,
      };
    const token = sessions.create(user.UsuarioId);
    if (req.get("X-Client") === "hh-app") {
      return res.json({
        user: publicUser(refreshed),
        token,
        expiresIn: config.sessionTtlMs / 1000,
      });
    }
    res.cookie(cookieName, token, {
      ...cookieOptions,
      maxAge: config.sessionTtlMs,
    });
    res.json({ user: publicUser(refreshed) });
  });
  app.get("/api/auth/me", requireUser, (req, res) => {
    res.json({ user: publicUser(req.authUser) });
  });
  app.post("/api/auth/logout", (req, res) => {
    sessions.delete(requestToken(req));
    res.clearCookie(cookieName, cookieOptions);
    res.status(204).end();
  });
  app.get("/api/mobile/summary", requireUser, async (req, res) => {
    const [summary, pending] = await Promise.all([
      deliveries.summary(req.authUser.UsuarioId),
      deliveries.today(req.authUser.UsuarioId),
    ]);
    res.json({ summary, pending, today: pending });
  });
  app.get("/api/deliveries/today", requireUser, async (req, res) => {
    res.json({ deliveries: await deliveries.today(req.authUser.UsuarioId) });
  });
  app.get("/api/deliveries/history", requireUser, async (req, res) => {
    const limit = Number(req.query.limit ?? 30);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      return res.status(400).json({ message: "Límite inválido." });
    res.json({
      deliveries: await deliveries.history(req.authUser.UsuarioId, limit),
    });
  });
  app.get(
    "/api/deliveries/:id",
    requireUser,
    validateDeliveryId,
    async (req, res) => {
      const delivery = await deliveries.detail(
        req.authUser.UsuarioId,
        req.params.id,
      );
      if (!delivery)
        return res.status(404).json({ message: "Entrega no encontrada." });
      res.json({ delivery });
    },
  );
  app.get("/api/cash-cut/today", requireUser, async (req, res) => {
    res.json({ summary: await deliveries.summary(req.authUser.UsuarioId) });
  });
  app.post(
    "/api/deliveries/:id/complete",
    requireUser,
    validateDeliveryId,
    async (req, res) => {
      const {
        amountDelivered,
        receiverName,
        signatureStrokes,
        videoBase64,
        videoMimeType,
        videoSizeBytes,
        observations,
        idempotencyKey,
      } = req.body ?? {};
      if (
        typeof amountDelivered !== "number" ||
        !Number.isFinite(amountDelivered) ||
        amountDelivered < 0 ||
        amountDelivered > 99_999_999 ||
        typeof receiverName !== "string" ||
        !receiverName.trim() ||
        receiverName.trim().length > 400 ||
        !hasSignature(signatureStrokes) ||
        typeof videoBase64 !== "string" ||
        videoBase64.length < 1024 ||
        videoBase64.length > 28_000_000 ||
        typeof videoMimeType !== "string" ||
        !videoMimeTypes.has(videoMimeType) ||
        typeof videoSizeBytes !== "number" ||
        !Number.isInteger(videoSizeBytes) ||
        videoSizeBytes < 1024 ||
        videoSizeBytes > 21_000_000 ||
        typeof idempotencyKey !== "string" ||
        !uuidPattern.test(idempotencyKey) ||
        (observations !== undefined &&
          (typeof observations !== "string" || observations.length > 2000))
      ) {
        return res.status(400).json({
          message:
            "Captura importe, receptor, firma y video válido para registrar la entrega.",
        });
      }
      const result = await deliveries.complete(req.authUser.UsuarioId, req.params.id, {
        amountDelivered,
        receiverName: receiverName.trim(),
        signatureStrokes,
        videoBase64,
        videoMimeType,
        videoExtension: videoMimeType === "video/mp4" ? ".mp4" : ".mov",
        videoSizeBytes,
        observations,
        idempotencyKey,
      });
      if (result.ok) return res.status(201).json({ ok: true });
      if (result.status === 404)
        return res.status(404).json({ message: "Entrega no encontrada." });
      return res.status(409).json({
        message: "Esta entrega ya fue registrada.",
      });
    },
  );
  app.post(
    "/api/deliveries/:id/issue",
    requireUser,
    validateDeliveryId,
    async (req, res) => {
      const { reason, returnAmount, observations, idempotencyKey } =
        req.body ?? {};
      if (
        typeof reason !== "string" ||
        !reason.trim() ||
        reason.trim().length > 500 ||
        typeof returnAmount !== "number" ||
        !Number.isFinite(returnAmount) ||
        returnAmount < 0 ||
        returnAmount > 99_999_999 ||
        typeof idempotencyKey !== "string" ||
        !uuidPattern.test(idempotencyKey) ||
        (observations !== undefined &&
          (typeof observations !== "string" || observations.length > 2000))
      ) {
        return res.status(400).json({
          message: "Captura motivo e importe a regresar para registrar la incidencia.",
        });
      }
      const ok = await deliveries.reportIssue(req.authUser.UsuarioId, req.params.id, {
        reason: reason.trim(),
        returnAmount,
        observations,
        idempotencyKey,
      });
      if (!ok)
        return res.status(404).json({
          message: "Entrega no encontrada o ya cerrada.",
        });
      res.status(201).json({ ok: true });
    },
  );
  app.use((_req, res) =>
    res.status(404).json({ message: "Ruta no encontrada." }),
  );
  app.use((error, _req, res, _next) => {
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ message: "JSON inválido." });
    if (error.type === "entity.too.large")
      return res.status(413).json({ message: "Solicitud demasiado grande." });
    console.error("API request failed:", error.code || error.name);
    res.status(503).json({
      message: "No pudimos conectar con el servicio. Intenta nuevamente.",
    });
  });
  return app;
}
