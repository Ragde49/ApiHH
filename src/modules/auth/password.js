import { pbkdf2, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(pbkdf2);
const iterations = 150000;
const algorithm = "PBKDF2-HMAC-SHA256";
const dummy = {
  PasswordAlgorithm: algorithm,
  PasswordIterations: iterations,
  PasswordSalt: Buffer.alloc(32),
  PasswordHash: Buffer.alloc(32),
};

export async function verifyPassword(password, user) {
  const record = user ?? dummy;
  const {
    PasswordAlgorithm: algorithm,
    PasswordIterations: iterations,
    PasswordSalt: salt,
    PasswordHash: hash,
  } = record;
  if (
    algorithm !== "PBKDF2-HMAC-SHA256" ||
    !Number.isInteger(iterations) ||
    iterations < 1 ||
    iterations > 2_000_000 ||
    !Buffer.isBuffer(salt) ||
    salt.length < 1 ||
    salt.length > 32 ||
    !Buffer.isBuffer(hash) ||
    hash.length < 16 ||
    hash.length > 64
  ) {
    await derive(
      password,
      dummy.PasswordSalt,
      dummy.PasswordIterations,
      32,
      "sha256",
    );
    return false;
  }
  const actual = await derive(
    password,
    salt,
    iterations,
    hash.length,
    "sha256",
  );
  return timingSafeEqual(actual, hash) && user !== null && user !== undefined;
}

export async function hashPassword(password) {
  const salt = randomBytes(32);
  const hash = await derive(password, salt, iterations, 32, "sha256");
  return {
    PasswordAlgorithm: algorithm,
    PasswordIterations: iterations,
    PasswordSalt: salt,
    PasswordHash: hash,
  };
}
