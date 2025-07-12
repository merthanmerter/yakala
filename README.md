# yakala

A TypeScript utility for robust error handling, retries, and stream processing.

## Installation

```bash
npm install yakala
```

```bash
bun add yakala
```

```bash
pnpm add yakala
```

```bash
yarn add yakala
```

## Examples

### Basic Error Handling and Response Transformation

```typescript
import { yakala } from "yakala";

// Example 1: Error handling with retries, circuit breaker, and response transformation
const safe = yakala(promiseHandler)
	// Define a custom error type with status code
	.kind("TestError", { code: "TEST_ERROR", status: 400 })
	// Throw errors instead of returning them
	// .throw()
	// Retry failed attempts with delay
	.retry({
		retries: 2,
		delay: 1000,
		onRetry: (err, c, t) => console.log(`🙉 Retry ${c}/${t}: ${err.message}`),
	})
	// Add circuit breaker to prevent cascade failures
	.circuit({
		fallback: () => "Fallback",
		threshold: 2,
		timeout: 1000,
	})
	// Add a pipe function to process
	.pipe((ctx) => {
		if (ctx.error) {
			ctx.error.message = "Test Error Altered";
			ctx.error.name = "TestErrorAltered";
			ctx.error.code = "TEST_ERROR_ALTERED";
			ctx.error.status = 500;
			return ctx.error;
		}
		return ctx.value;
	})
	.pipe((ctx) => {
		if (ctx.value) {
			const enriched = {
				value: ctx.value,
				enriched: true,
				timestamp: new Date().toISOString(),
			};
			return enriched;
		}
	});

// Test successful case
const { value: value1, error: error1 } = await safe.handle(true);

console.log({
	value: value1,
	error: {
		name: error1?.name,
		code: error1?.code,
		message: error1?.message,
		status: error1?.status,
	},
});

/*
{
  value: {
    value: "Success",
    enriched: true,
    timestamp: "2025-07-12T21:21:38.349Z",
  },
  error: {
    name: undefined,
    code: undefined,
    message: undefined,
    status: undefined,
  },
}
*/

// Test error case
const { value: value2, error: error2 } = await safe.handle(false);

console.log({
	value: value2,
	error: {
		name: error2?.name,
		code: error2?.code,
		message: error2?.message,
		status: error2?.status,
	},
});

/*
🙉 Retry 1/2: Test Error
🙉 Retry 2/2: Test Error
{
  value: undefined,
  error: {
    name: "TestError",
    code: "TEST_ERROR",
    message: "Test Error Altered",
    status: 400,
  },
}
*/

// Example 2: Stream handling with retries and event handlers
const stream = yakala(streamApiResponse)
	// Retry stream failures
	.retry({
		retries: 2,
		delay: 1000,
		onRetry: (err, c, t) => console.log(`🙉 Retry ${c}/${t}: ${err.message}`),
	})
	// Handle stream events with custom formatting
	.stream({
		onSuccess: (value) => `🐵 ${value.status} ${value.statusText}`,
		onError: (err) => `🙈 ${err.message}`,
		onEnd: () => "🐒 Stream ended",
	});

for await (const item of stream()) {
	console.log(item);
}

/*
🐵 200 OK
🐵 200 OK
🐵 200 OK
🐵 200 OK
🙉 Retry 1/2: Rate limit exceeded
🐵 200 OK
🐵 200 OK
🙉 Retry 2/2: Rate limit exceeded
🙈 Rate limit exceeded
🐒 Stream ended
*/

```

## API

### `yakala(fn)`

Creates a builder for safely handling function execution with error handling, retries, and transformations.

#### Builder Methods

- `.kind(name, options)`: Define custom error types with additional properties
- `.throw()`: Configure to throw errors instead of returning them
- `.retry(options)`: Configure automatic retry behavior
- `.circuit(options)`: Add circuit breaker pattern
- `.pipe(fn)`: Transform results or errors
- `.stream(handlers)`: Convert to stream with event handlers
- `.handle(...args)`: Execute and return Result object

## License

MIT
