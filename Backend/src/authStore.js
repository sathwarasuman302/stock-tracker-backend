
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJsonState, saveJsonState } from "./persistence.js";


const authStorePath = process.env.AUTH_USERS_PATH
	? resolve(process.env.AUTH_USERS_PATH)
	: join(dirname(fileURLToPath(import.meta.url)), "..", "data", "auth-users.json");
const deletedUsersPath = process.env.AUTH_DELETED_USERS_PATH
	? resolve(process.env.AUTH_DELETED_USERS_PATH)
	: join(dirname(fileURLToPath(import.meta.url)), "..", "data", "auth-deleted-users.json");

let authStoreQueue = Promise.resolve();

const deletionMarker = (email) => createHash("sha256").update(email).digest("hex");

const readUsers = async () => {
	const users = await loadJsonState("auth-users", authStorePath, []);
	if (!Array.isArray(users)) throw new Error("The authentication store is invalid.");
	return users;
};

const readLegacyUsers = async () => {
	try {
		const users = JSON.parse(await readFile(authStorePath, "utf8"));
		if (!Array.isArray(users)) throw new Error("The authentication store is invalid.");
		return users;
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
};

const writeUsers = (users) => saveJsonState("auth-users", authStorePath, users);

const readDeletedEmails = async () => {
	const emails = await loadJsonState("auth-deleted-users", deletedUsersPath, []);
	if (!Array.isArray(emails)) throw new Error("The deleted-user store is invalid.");
	return emails;
};

const writeDeletedEmails = (emails) => saveJsonState("auth-deleted-users", deletedUsersPath, emails);

export const initializeAuthStore = async () => {
	const [users, deletedEmails, legacyUsers] = await Promise.all([
		readUsers(),
		readDeletedEmails(),
		readLegacyUsers(),
	]);
	const deletedEmailMarkers = new Set(deletedEmails);
	const usersByEmail = new Map(
		users.map((user) => [String(user.email ?? "").toLowerCase(), user])
	);

	for (const user of legacyUsers) {
		const email = String(user?.email ?? "").trim().toLowerCase();
		if (
			!email ||
			deletedEmailMarkers.has(deletionMarker(email)) ||
			usersByEmail.has(email) ||
			typeof user.passwordHash !== "string" ||
			!/^[a-f\d]{32}:[a-f\d]{128}$/i.test(user.passwordHash) ||
			!["investor", "trader", "admin"].includes(user.role)
		) {
			continue;
		}

		usersByEmail.set(email, {
			first_name: String(user.first_name ?? ""),
			last_name: String(user.last_name ?? ""),
			email,
			role: user.role,
			...(typeof user.avatarUrl === "string" ? { avatarUrl: user.avatarUrl } : {}),
			passwordHash: user.passwordHash,
			createdAt: Number.isFinite(user.createdAt) ? user.createdAt : Date.now(),
		});
	}

	await writeUsers([...usersByEmail.values()]);
};

const runSerialized = (operation) => {
	const result = authStoreQueue.then(operation);
	authStoreQueue = result.then(() => undefined, () => undefined);
	return result;
};

const createPasswordHash = (password) => {
	const salt = randomBytes(16).toString("hex");
	const hash = scryptSync(password, salt, 64).toString("hex");
	return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
	const [salt, expectedHex] = String(storedHash ?? "").split(":");
	if (!salt || !expectedHex || !/^[a-f\d]+$/i.test(expectedHex)) return false;
	const expected = Buffer.from(expectedHex, "hex");
	if (expected.length !== 64) return false;
	const actual = scryptSync(password, salt, expected.length);
	return expected.length === actual.length && timingSafeEqual(expected, actual);
};

const toPublicUser = ({ password: _password, passwordHash: _passwordHash, ...user }) => user;

export const registerAuthUser = (user) => runSerialized(async () => {
	const deletedEmails = await readDeletedEmails();
	if (deletedEmails.includes(deletionMarker(user.email))) return null;
	const users = await readUsers();
	if (users.some((entry) => entry.email === user.email)) return null;

	const storedUser = {
		first_name: user.first_name,
		last_name: user.last_name,
		email: user.email,
		role: user.role,
		...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
		passwordHash: createPasswordHash(user.password),
		createdAt: Date.now(),
	};
	await writeUsers([...users, storedUser]);
	return toPublicUser(storedUser);
});

export const authenticateAuthUser = (email, password) => runSerialized(async () => {
	if ((await readDeletedEmails()).includes(deletionMarker(email))) return null;
	const users = await readUsers();
	const user = users.find((entry) => entry.email === email);
	return user && verifyPassword(password, user.passwordHash) ? toPublicUser(user) : null;
});

export const updateAuthUserAvatar = (email, role, avatarUrl) => runSerialized(async () => {
	const users = await readUsers();
	const userIndex = users.findIndex((entry) => entry.email === email && entry.role === role);
	if (userIndex === -1) return null;
	const updatedUser = { ...users[userIndex], avatarUrl };
	users[userIndex] = updatedUser;
	await writeUsers(users);
	return toPublicUser(updatedUser);
});

export const listAuthUsers = () => runSerialized(async () =>
	(await readUsers()).map(toPublicUser)
);

export const deleteAuthUser = (email) => runSerialized(async () => {
	const deletedEmails = await readDeletedEmails();
	const marker = deletionMarker(email);
	if (!deletedEmails.includes(marker)) await writeDeletedEmails([...deletedEmails, marker]);

	const users = await readUsers();
	const remainingUsers = users.filter((user) => user.email !== email);
	if (remainingUsers.length !== users.length) await writeUsers(remainingUsers);
	return users.length - remainingUsers.length;
});

export const isDeletedAuthEmail = (email) => runSerialized(async () =>
	(await readDeletedEmails()).includes(deletionMarker(email))
);
