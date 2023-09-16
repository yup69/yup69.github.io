let key = null;
let startCounter = null;

const dataUrlToBytes = (() => {
	const dataUrlPrefix = 'data:application/octet-stream;base64,';

	return async function dataUrlToBytes(dataBase64Url) {
		const base64 = dataBase64Url.replaceAll(/-/g, '+').replaceAll(/_/g, '/');
		const response = await fetch(`${dataUrlPrefix}${base64}`);
		const buffer = await response.arrayBuffer();
		return new Uint8Array(buffer);
	};
})();

async function decryptAndEnqueue(controller, data, counterOffset, skip = null) {
	if (key === null) {
		throw new Error();
	}

	const counter = await seekCounter(counterOffset);

	const parameters = {
		name: 'AES-CTR',
		counter: counter,
		length: (16 * 8),
	};

	const decrypted = await decryptAndSkip(parameters, key, data, skip);
	controller.enqueue(decrypted);
}

async function decryptAndSkip(parameters, key, data, skip) {
	const decryptedBuffer = await self.crypto.subtle.decrypt(parameters, key, data);
	const decrypted = new Uint8Array(decryptedBuffer);

	if (skip === null) {
		return decrypted;
	}

	return decrypted.slice(skip);
}

const getRangeStart = (() => {
	const pattern = /^bytes=(?<start>\d+)-(?:\d+)?$/;

	return function getRangeStart(request) {
		const range = request.headers.get('Range');

		if (range === null) {
			return 0n;
		}

		const match = pattern.exec(range);

		if (match === null) {
			return null;
		}

		return BigInt(match.groups.start);
	};
})();

async function seekCounter(offset) {
	if (startCounter === null) {
		throw new Error();
	}

	if (offset === 0n) {
		return startCounter;
	}

	let bigIntCounter = 0n;

	// Interpret the bytes as a big-endian integer.
	for (const [index, byte] of startCounter.entries()) {
		const shift = ((15n - BigInt(index)) * 8n);
		bigIntCounter |= (BigInt(byte) << shift);
	}

	bigIntCounter += (offset / 16n);

	// Convert the integer back into bytes.
	return new Uint8Array(Array(16).fill(0).map((byte, index) => {
		const shift = ((15n - BigInt(index)) * 8n);
		return Number((bigIntCounter >> shift) & BigInt(0xff));
	}));
}

async function getResponse(request) {
	let byteOffset = getRangeStart(request);

	if (byteOffset === null) {
		// "Range Not Satisfiable".
		return new Response('', {status: 416});
	}

	const response = await fetch(request.url, {headers: request.headers});
	const encryptedStreamReader = response.body.getReader();
	const pendingBytes = [];

	const decryptedStream = new ReadableStream({
		async cancel() {
			await encryptedStreamReader.cancel();
		},
		async pull(controller) {
			if (controller.byobRequest !== null) {
				throw new Error();
			}

			if (pendingBytes.length !== 0) {
				controller.enqueue(pendingBytes.shift());
				return;
			}

			const streamChunk = await encryptedStreamReader.read();

			if (streamChunk.done) {
				controller.close();
				return;
			}

			const paddingLengthBigInt = (byteOffset % 16n);
			const streamChunkLength = BigInt(streamChunk.value.length);

			if (paddingLengthBigInt === 0n) {
				await decryptAndEnqueue(controller, streamChunk.value, byteOffset);
				byteOffset += streamChunkLength;
				return;
			}

			const paddingLength = Number(paddingLengthBigInt);
			const partialAesChunkLength = (16 - paddingLength);
			// Round down to the nearest chunk boundary.
			byteOffset -= paddingLengthBigInt;
			const partialAesChunk = streamChunk.value.slice(0, partialAesChunkLength);

			const headAesChunk = new Uint8Array(16);
			headAesChunk.set(new Uint8Array(paddingLength));
			headAesChunk.set(partialAesChunk, paddingLength);

			await decryptAndEnqueue(controller, headAesChunk, byteOffset, paddingLength);
			// Move to the next chunk boundary.
			byteOffset += 16n;

			const remainingBytes = (streamChunkLength - BigInt(partialAesChunkLength));

			if (remainingBytes === 0n) {
				// There are no more bytes to process in this stream chunk.
				return;
			}

			const tailBytes = streamChunk.value.slice(partialAesChunkLength);
			await decryptAndEnqueue({enqueue(bytes) {pendingBytes.push(bytes);}}, tailBytes, byteOffset);
			// Adjust the offset to the end of the stream chunk.
			byteOffset += remainingBytes;
		},
		type: 'bytes',
	});

	return new Response(decryptedStream, {
		headers: response.headers,
		status: response.status,
	});
}

self.addEventListener('activate', (event) => {
	event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
	const requestUrl = new URL(event.request.url);

	if (requestUrl.origin !== 'https://dl.dropboxusercontent.com') {
		return;
	}

	event.respondWith(getResponse(event.request));
});

self.addEventListener('install', async () => {
	await self.skipWaiting();
});

self.addEventListener('message', async (event) => {
	if (event.data.type !== 'configure') {
		throw new Error();
	}

	const [startCounterBase64, keyBase64] = event.data.parameters;
	let keyBytes;

	try {
		startCounter = await dataUrlToBytes(startCounterBase64);
		keyBytes = await dataUrlToBytes(keyBase64);
	} catch {
		event.source.postMessage({type: 'error'});
		return;
	}

	key = await self.crypto.subtle.importKey('raw', keyBytes, 'AES-CTR', true, ['encrypt', 'decrypt']);
	event.source.postMessage({type: 'configured'});
});
