import { loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createUserRepository } from "./modules/auth/repository.js";
import { createDeliveryRepository } from "./modules/deliveries/repository.js";
import { createSessionStore } from "./modules/auth/sessions.js";
import { createApp } from "./app.js";

const config = loadConfig();
const database = createDatabase(config.db);
const sessions = createSessionStore(config.sessionTtlMs);
const app = createApp({
  config,
  users: createUserRepository(database),
  deliveries: createDeliveryRepository(database),
  sessions,
});
const server = app.listen(config.port, "0.0.0.0", () =>
  console.log(`HH API disponible en puerto ${config.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    const timeout = setTimeout(() => process.exit(1), 10000);
    timeout.unref();
    server.close(async () => {
      sessions.close();
      await database.close();
      process.exit(0);
    });
  });
