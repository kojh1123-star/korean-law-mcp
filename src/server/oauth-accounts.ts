import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto"
import { promisify } from "node:util"

const scrypt = promisify(scryptCallback)
const HASH_PATTERN = /^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/
export interface Employee { id: string; passwordHash: string }

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 256) {
    throw new Error("Password must be at least 12 characters and at most 256 UTF-8 bytes.")
  }
  const salt = randomBytes(16).toString("hex")
  const hash = await scrypt(password, salt, 64) as Buffer
  return `scrypt-v1$${salt}$${hash.toString("hex")}`
}

export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== "string" || Buffer.byteLength(password) > 256 || !HASH_PATTERN.test(encoded)) return false
  const [, salt, expected] = encoded.split("$")
  const actual = await scrypt(password, salt, 64) as Buffer
  return timingSafeEqual(actual, Buffer.from(expected, "hex"))
}

export function readEmployees(raw: string | undefined): Map<string, Employee> {
  let values: unknown
  try { values = JSON.parse(raw ?? "") } catch { throw new Error("OAUTH_USERS_JSON must be a JSON array of employee IDs and password hashes.") }
  if (!Array.isArray(values) || values.length === 0 || values.length > 1000) throw new Error("OAUTH_USERS_JSON requires 1–1000 employees.")
  const employees = new Map<string, Employee>()
  for (const value of values) {
    if (!value || typeof value.id !== "string" || !/^[a-zA-Z0-9._-]{3,64}$/.test(value.id)
      || typeof value.passwordHash !== "string" || !HASH_PATTERN.test(value.passwordHash)
      || employees.has(value.id)) throw new Error("Invalid or duplicate employee in OAUTH_USERS_JSON. Use the account setup command.")
    employees.set(value.id, { id: value.id, passwordHash: value.passwordHash })
  }
  return employees
}
