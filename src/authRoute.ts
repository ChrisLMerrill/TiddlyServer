import { StateObject, ServerEventEmitter, tryParseJSON, ER, ServerConfig, serveFile } from "./server-types";
import { EventEmitter } from "events";
import * as crypto from "crypto";
import { libsodium, ws as WebSocket } from "../lib/bundled-lib";
import { TLSSocket } from "tls";
import * as http from "http";
import * as path from "path";
const sockets: WebSocket[] = [];
const state: {}[] = [];
/** [type, username, timestamp, hash, sig] */
export type AuthCookie = [string, "pw" | "key", string, string, string]
export let checkCookieAuth: (request: http.IncomingMessage, logRegisterNotice: boolean) => [string, string] | false;
/** if the cookie is valid it returns the username, otherwise an empty string. If the public key cannot be found, it will call logRegisterNotice then return an empty string */
export let validateCookie: (json: AuthCookie, logRegisterNotice?: (string | false)) => [string, string] | false;
export let parseAuthCookie = (cookie: string): AuthCookie => {
	let json: [string, "pw" | "key", string, string, string] = cookie.split("|") as any; //tryParseJSON<>(auth);
	if (json.length > 5) {
		let name = json.slice(0, json.length - 4);
		let rest = json.slice(json.length - 4);
		json = [name.join("|"), ...rest] as any;
	}
	return json;
}
const setAuth = (settings: ServerConfig) => {
	// let ca: Record<string, x509.Certificate[]> = {};
	// let up: [string, string, string][] = [] as any;
	/** Record<hash+username, [authGroup, publicKey]> */
	let publicKeyLookup: Record<string, [string, string]> = {};
	let passwordLookup: Record<string, string> = {};
	const {
		crypto_generichash,
		crypto_generichash_BYTES,
		crypto_generichash_BYTES_MIN,
		crypto_generichash_BYTES_MAX,
		crypto_sign_keypair,
		crypto_sign_verify_detached,
		from_base64,
		crypto_box_SEEDBYTES,
	} = libsodium;
	console.log(crypto_box_SEEDBYTES, crypto_generichash_BYTES, crypto_generichash_BYTES_MAX, crypto_generichash_BYTES_MIN);
	// let passwordKey = crypto_sign_keypair("uint8array");
	// console.log(settings.authAccounts);
	Object.keys(settings.authAccounts).forEach(k => {
		let e = settings.authAccounts[k];
		// console.log(k, e, e.clientKeys);
		if (e.clientKeys) Object.keys(e.clientKeys).forEach(u => {
			console.log(k, u, e.clientKeys[u]);
			const publicKey = from_base64(e.clientKeys[u]);

			let publicHash = crypto_generichash(crypto_generichash_BYTES, publicKey, undefined, "base64");
			if (!publicKeyLookup[publicHash + u]) publicKeyLookup[publicHash + u] = [k, e.clientKeys[u]];
			else throw "publicKey+username combination is used for more than one authAccount";
		});
		// if (e.passwords) Object.keys(e.passwords).forEach(u => {
		// 	const password = e.passwords[u];
		// 	let passHash = crypto_generichash(crypto_generichash_BYTES, password, undefined, "base64");
		// 	if (!passwordLookup[u]) passwordLookup[u] = k;
		// 	else throw "username is used for more than one authAccount password list";
		// });
	});

	checkCookieAuth = (request: http.IncomingMessage, logRegisterNotice: boolean) => {
		if (!request.headers.cookie) return false;
		var cookies = {}, rc = request.headers.cookie as string;
		rc.split(';').forEach(function (cookie) {
			var parts = cookie.split('=');
			cookies[(parts.shift() as string).trim()] = parts.length ? decodeURI(parts.join('=')) : "";
		});
		let auth = cookies["TiddlyServerAuth"] as string;
		if (!auth) return false;
		let json = parseAuthCookie(auth);
		if (!json) return false;
		return validateCookie(json, false);
	};

	validateCookie = (json: [string, "pw" | "key", string, string, string], logRegisterNotice?: string | false) => {
		let [username, type, timestamp, hash, sig] = json;
		if (type === "key" && !publicKeyLookup[hash + username]) {
			// console.log(publicKeyLookup);
			if (logRegisterNotice) console.log(logRegisterNotice);
			return false;
		}
		// console.log(username + timestamp + hash);
		if (type === "pw") return false; //passwords are currently not implemented
		let valid = crypto_sign_verify_detached(
			from_base64(sig),
			username + timestamp + hash,
			from_base64(publicKeyLookup[hash + username][1])
		);
		// console.log((valid ? "" : "in") + "valid signature")
		return valid ? [publicKeyLookup[hash + username][0], username] : false;
	};

}
export function initAuthRoute(eventer: ServerEventEmitter) {
	// eventer.on("websocket-connection", (client, request) => {
	// 	if (request.url === "/admin/authenticate") {
	// 		sockets.push(client);
	// 		client.on("message", handleSocketMessage);
	// 	}
	// });
	eventer.on("settings", (set) => {
		setAuth(set);
	})
}

const pko: Record<string, { step: number, cancelTimeout: NodeJS.Timer, sender?: StateObject, reciever?: StateObject }> = {};

function removePendingPinTimeout(pin: string) {
	return setTimeout(() => { delete pko[pin] }, 10 * 60 * 1000)
}
function handleTransfer(state: StateObject) {
	let pin = state.path[4];
	if (!state.path[4] || !pko[pin] || (state.path[5] !== "sender" && state.path[5] !== "reciever"))
		return state.throwReason(400, "Invalid request parameters");
	let direction: "sender" | "reciever" = state.path[5] as any;
	let pkop = pko[pin];
	pkop[direction] = state;
	if (!pkop.sender || !pkop.reciever) return;
	clearTimeout(pkop.cancelTimeout);
	pkop.step += 1;
	pkop.sender.res.writeHead(200, undefined, { "x-tiddlyserver-transfer-count": pkop.step });
	pkop.reciever.req.pipe(pkop.sender.res);
	pkop.reciever.res.writeHead(200, undefined, { "x-tiddlyserver-transfer-count": pkop.step });
	pkop.sender.req.pipe(pkop.reciever.res);
	pkop.cancelTimeout = removePendingPinTimeout(pin);
}
let randomPin;
libsodium.ready.then(() => { randomPin = libsodium.randombytes_buf(8) });
function getRandomPin() {
	let pin = "";
	while (!pin || pko[pin])
		pin = libsodium.to_hex(
			randomPin = libsodium.crypto_generichash(8, randomPin, undefined, "uint8array")
		);
	pko[pin] = { step: 1, cancelTimeout: removePendingPinTimeout(pin) };
	return pin;
}
const DEFAULT_AGE = "2592000";
export function getSetCookie(name: string, value: string, secure: boolean, age: number) {
	// let flags = ["Secure", "HttpOnly", "Max-Age=2592000", "SameSite=Strict"];
	let flags = {
		"Secure": secure,
		"HttpOnly": true,
		"Max-Age": age.toString(),
		"SameSite": "Strict",
		"Path": "/"
	}

	return [
		name + "=" + value,
		...Object.keys(flags).filter(k => !!flags[k]).map(k => k + (typeof flags[k] === "string" ? "=" + flags[k] : ""))
	].join("; ");
}

/** Handles the /admin/authenticate route */
export function handleAuthRoute(state: StateObject) {
	if (state.req.method === "GET" || state.req.method === "HEAD") {
		if (state.path.length === 4 && state.path[3] === "login.html") {
			serveFile(state, "login.html", path.join(state.settings.__assetsDir, "authenticate"));
		} else if (state.path.length === 4 && state.path[3] === "transfer.html") {
			serveFile(state, "transfer.html", path.join(state.settings.__assetsDir, "authenticate"));
		} else {
			state.throw(404);
		}
		return;
	}
	//state.path[3]: "sendkey" | "recievekey" | "login" | "logout" | "pendingpin"
	if (state.req.method !== "POST")
		return state.throw(405);
	if (state.path[3] === "transfer") {
		handleTransfer(state);
	} else if (state.path[3] === "pendingpin") {
		if (Object.keys(pko).length > 1000)
			return state.throwReason(509, "Too many transfer requests in progress");
		else
			state.respond(200).json({ pendingPin: getRandomPin() });
	} else if (state.path[3] === "login") {
		state.recieveBody(true, true).then(() => {
			if (state.body.length && !state.json) return; //recieve body sent a response already
			if (!state.body.length) return state.throwReason(400, "Empty request body");
			/** [username, type, timestamp, hash, sig] */
			let json = parseAuthCookie(state.json.setCookie);
			if (json.length !== 5) return state.throwReason(400, "Bad cookie format");
			let { registerNotice } = state.settings.bindInfo.hostLevelPermissions[state.hostLevelPermissionsKey];
			let username = validateCookie(json, registerNotice && [
				"    login attempted with unknown public key",
				"    " + state.json.publicKey,
				"    username: " + json[1],
				"    timestamp: " + json[2]
			].join("\n"));
			if (username) {
				state.setHeader("Set-Cookie", getSetCookie("TiddlyServerAuth", state.json.setCookie, false, state.settings.authCookieAge));
				state.respond(200).empty();
			} else {
				state.throwReason(400, "INVALID_CREDENTIALS");
			}
		})
	} else if (state.path[3] === "logout") {
		state.setHeader("Set-Cookie", getSetCookie("TiddlyServerAuth", "", false, 0));
		state.respond(200).empty();
	}
	return;
	/* Create cookie for authentication. Can only be secured with HTTPS, otherwise anyone can "borrow" it */{
		const { crypto_generichash_BYTES, crypto_sign_keypair, crypto_sign_detached, crypto_sign_verify_detached, crypto_generichash, from_base64 } = libsodium;
		let keys = crypto_sign_keypair("uint8array");
		// Never use the public key included in a message to check its signature.
		let publicHash = crypto_generichash(crypto_generichash_BYTES, keys.publicKey, undefined, "base64");
		let cookie = ["key", "my username", new Date().toISOString(), publicHash];
		let signed = crypto_sign_detached(cookie[0] + cookie[1] + cookie[2], keys.privateKey, "base64");
		cookie.push(signed);
		let request = {
			setCookie: JSON.stringify(signed),
			publicKey: keys.publicKey
		}
		//check the cookie on the server to make sure it is valid
		let valid = crypto_sign_verify_detached(from_base64(signed), cookie[0] + cookie[1] + cookie[2], keys.publicKey);
	}

	/* create secure channel for transferring private key */{
		const { crypto_kx_client_session_keys, crypto_kx_server_session_keys, crypto_kx_keypair, from_base64, to_base64, randombytes_buf, crypto_secretbox_easy } = libsodium;

		let clientKeys = crypto_kx_keypair("uint8array");
		let clientPublicKey = to_base64(clientKeys.publicKey);

		let senderKeys = crypto_kx_keypair("uint8array");
		let senderPublicKey = to_base64(senderKeys.publicKey);

		//exchange the public keys here

		let clientSession = crypto_kx_client_session_keys(clientKeys.publicKey, clientKeys.privateKey, from_base64(senderPublicKey), "uint8array");
		let clientCheck = libsodium.crypto_generichash(
			Math.max(libsodium.crypto_generichash_BYTES_MIN, 8),
			//server_to_client + client_to_server
			to_base64(clientSession.sharedRx) + to_base64(clientSession.sharedTx),
			undefined, "uint8array"
		);

		let senderSession = crypto_kx_server_session_keys(senderKeys.publicKey, senderKeys.privateKey, from_base64(clientPublicKey), "uint8array");
		let senderCheck = libsodium.crypto_generichash(
			Math.max(libsodium.crypto_generichash_BYTES_MIN, 8),
			//server_to_client + client_to_server
			to_base64(senderSession.sharedTx) + to_base64(senderSession.sharedRx),
			undefined, "uint8array"
		);

		// compare the two checks, they should be exactly the same
		if (senderCheck !== clientCheck) throw "aghhhh!! someone messed with our key!!";

		//encrypt the auth key on the sender
		let nonce = randombytes_buf(16);
		let encryptedKey = crypto_secretbox_easy("KEY PAIR OBJECT JSON", nonce, senderSession.sharedTx, "base64");

		//decrypt on the client
		let decryptedKey = libsodium.crypto_secretbox_open_easy(encryptedKey, nonce, clientSession.sharedRx);
	}

}