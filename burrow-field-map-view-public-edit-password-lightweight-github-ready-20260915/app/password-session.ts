import { env } from "cloudflare:workers";

const PASSWORD_ENV = "APP_PASSWORD";
const SESSION_COOKIE = "burrow-password-session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const encoder = new TextEncoder();

export function isPasswordConfigured() {
  return configuredPassword().length > 0;
}

export async function verifyPassword(candidate: unknown) {
  if (typeof candidate !== "string") return false;
  const expected = configuredPassword();
  return expected.length > 0 && constantTimeEqual(candidate, expected);
}

export async function isPasswordSessionValid(request: Request) {
  const password = configuredPassword();
  if (!password) return false;
  const cookie = readCookie(request.headers.get("Cookie"), SESSION_COOKIE);
  if (!cookie) return false;
  return constantTimeEqual(cookie, await sessionToken(password));
}

export async function createPasswordSessionCookie(request: Request) {
  const password = configuredPassword();
  if (!password) throw new Error("アプリのパスワードが未設定です。");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${await sessionToken(password)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
}

export function clearPasswordSessionCookie(request: Request) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
}

function configuredPassword() {
  return String((env as Record<string, unknown>)[PASSWORD_ENV] ?? "");
}

async function sessionToken(password: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`burrow-field-map-session:${password}`),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function readCookie(header: string | null, name: string) {
  if (!header) return "";
  for (const item of header.split(";")) {
    const [cookieName, ...parts] = item.trim().split("=");
    if (cookieName === name) return parts.join("=");
  }
  return "";
}

function constantTimeEqual(left: string, right: string) {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
