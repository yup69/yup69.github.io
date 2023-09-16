(async () => {
	function addOnceEventListener(target, type, listener) {
		target.addEventListener(type, listener, {once: true});
	}

	async function awaitEvent(target, type) {
		return await new Promise((resolve) => {
			addOnceEventListener(target, type, resolve);
		});
	}

	const error = document.querySelector('#error');
	const button = document.querySelector('button');
	const progress = document.querySelector('progress');
	const video = document.querySelector('video');

	const hash = Array.from(document.location.hash.slice(1)).join('');
	const parts = 4;
	const parameters = hash.split(',', (parts + 1));

	const controllerSetEvent = (async () => {
		if (navigator.serviceWorker.controller !== null) {
			return true;
		}

		return await awaitEvent(navigator.serviceWorker, 'controllerchange');
	})();

	await navigator.serviceWorker.register('worker.js');
	await controllerSetEvent;

	const [succeeded, dropboxId, dropboxKey] = await (async () => {
		if (parameters.length !== parts) {
			return [false, null, null];
		}

		const [dropboxId, dropboxKey, aesIv, aesKey] = parameters;
		const messageEventPromise = awaitEvent(navigator.serviceWorker, 'message');
		navigator.serviceWorker.controller.postMessage({type: 'configure', parameters: [aesIv, aesKey]});
		const messageEvent = await messageEventPromise;
		const succeeded = (messageEvent.data.type === 'configured');
		return [succeeded, dropboxId, dropboxKey];
	})();

	if (!succeeded) {
		progress.hidden = true;
		error.hidden = false;
		return;
	}

	addOnceEventListener(button, 'click', () => {
		button.hidden = true;
		const videoUrl = new URL('https://dl.dropboxusercontent.com');
		videoUrl.pathname = `/s/${dropboxId}/export.img`;
		videoUrl.searchParams.set('rlkey', dropboxKey);
		video.src = videoUrl.toString();
		video.hidden = false;
	});

	progress.hidden = true;
	button.hidden = false;
})();
