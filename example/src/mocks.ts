export const promiseHandler = async (shouldSucceed: boolean) => {
	return shouldSucceed
		? Promise.resolve("Success")
		: Promise.reject(new Error("Test Error"));
};

export const streamApiResponse = () => {
	let count = 0;

	return new ReadableStream<Response>({
		async start(controller) {
			while (count < 10) {
				await new Promise((resolve) => setTimeout(resolve, 300));
				count++;

				if (count === 3) {
					controller.error(new Error("Rate limit exceeded"));
					break;
				}

				controller.enqueue(
					new Response(JSON.stringify({ message: "Hello!", count }), {
						status: 200,
						statusText: "OK",
						headers: { "Content-Type": "application/json" },
					}),
				);
			}
			controller.close();
		},
	});
};
