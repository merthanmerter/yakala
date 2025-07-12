/**
 * Represents the result of a safe function execution that never throws.
 * @template T The type of the successful result value
 * @template E The type of the error (defaults to Error)
 */
export type Result<T, E extends Error = Error> =
	| { value: T; error: null }
	| { value: undefined; error: E };

/**
 * Context object passed to pipe functions containing execution details.
 * @template TArgs The function argument types
 * @template TCurrent The current return type being processed
 */
export type PipeContext<
	TArgs extends unknown[],
	TCurrent = unknown,
	TError extends Error = Error,
> = {
	value?: TCurrent;
	error?: TError;
	args: TArgs;
};

// Utility type to unwrap return types (handles promises, generators, iterables)
type UnwrapReturn<T> = T extends Promise<infer U>
	? U
	: T extends Generator<infer G, unknown, unknown>
		? G
		: T extends AsyncGenerator<infer AG, unknown, unknown>
			? AG
			: T extends Iterable<infer IT>
				? IT
				: T extends AsyncIterable<infer AIT>
					? AIT
					: T extends ReadableStream<infer R>
						? R
						: T;

// Type guards
function isPromise<T>(value: unknown): value is Promise<T> {
	return value instanceof Promise;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
	return Boolean(
		value && typeof value === "object" && Symbol.asyncIterator in value,
	);
}

function isIterable<T>(value: unknown): value is Iterable<T> {
	return Boolean(
		value && typeof value === "object" && Symbol.iterator in value,
	);
}

function isError(value: unknown): value is Error {
	return value instanceof Error;
}

function isReadableStream(value: unknown): value is ReadableStream {
	return value instanceof ReadableStream;
}

class CustomError extends Error {
	public readonly code?: string;
	public readonly status?: number;
	public readonly cause?: Error;

	constructor(
		name: string,
		message: string,
		options: { code?: string; status?: number; cause?: Error } = {},
	) {
		super(message);
		this.name = name;
		this.code = options.code;
		this.status = options.status;
		this.cause = options.cause;
		Object.setPrototypeOf(this, new.target.prototype);
	}
}

function createError(
	name: string,
	message: string,
	options: { code?: string; status?: number; cause?: Error } = {},
): CustomError {
	return new CustomError(name, message, options);
}

class CircuitBreaker<T> {
	private state: "closed" | "open" | "half-open" = "closed";
	private failureCount = 0;
	private readonly threshold: number;
	private readonly timeout: number;
	private readonly fallback: () => T | Promise<T>;

	constructor(
		fallback: () => T | Promise<T>,
		{
			threshold = 5,
			timeout = 5000,
		}: { threshold?: number; timeout?: number } = {},
	) {
		this.fallback = fallback;
		this.threshold = threshold;
		this.timeout = timeout;
		if (this.threshold <= 0) throw new Error("Threshold must be > 0");
		if (this.timeout < 0) throw new Error("Timeout must be >= 0");
	}

	async exec(fn: () => Promise<T>): Promise<T> {
		if (this.state === "open") return this.executeFallback();

		try {
			const result = await fn();
			this.reset();
			return result;
		} catch (error) {
			this.failureCount++;
			if (this.failureCount >= this.threshold) {
				this.state = "open";
				setTimeout(() => {
					this.state = "half-open";
				}, this.timeout);
			} else if (this.state === "half-open") {
				this.state = "open";
			}
			throw error;
		}
	}

	private async executeFallback(): Promise<T> {
		const fb = this.fallback();
		return isPromise(fb) ? await fb : fb;
	}

	private reset() {
		this.failureCount = 0;
		this.state = "closed";
	}
}

export interface YakalaBuilder<
	TArgs extends unknown[],
	TOriginalReturn,
	TCurrentReturn = TOriginalReturn,
	TError extends Error = Error,
> {
	/**
	 * Defines a custom error type with additional properties.
	 *
	 * @param name - The name of the custom error type
	 * @param options - Additional properties to attach to the error
	 * @returns A new builder with the custom error type
	 *
	 * @example
	 * ```ts
	 * yakala(fn)
	 *   .kind("ValidationError", { code: "INVALID_INPUT", status: 400 })
	 * ```
	 */
	kind<TOpts extends Record<string, unknown>>(
		name: string,
		options: TOpts,
	): YakalaBuilder<TArgs, TOriginalReturn, TCurrentReturn, Error & TOpts>;

	/**
	 * Configures the builder to throw errors instead of returning them in the Result object.
	 *
	 * @returns A new builder configured to throw errors
	 *
	 * @example
	 * ```ts
	 * yakala(fn)
	 *   .throw()
	 *   .handle() // Will throw instead of returning { error }
	 * ```
	 */
	throw(): YakalaBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>;

	/**
	 * Adds a transformation function to process the result or error.
	 *
	 * @param fn - Function to transform the context containing value/error
	 * @returns A new builder with the transformation added to the pipeline
	 *
	 * @example
	 * ```ts
	 * yakala(fn)
	 *   .pipe(ctx => {
	 *     if (ctx.value) return { ...ctx.value, enriched: true };
	 *   })
	 * ```
	 */
	pipe<TNext>(
		fn: (
			ctx: PipeContext<TArgs, TCurrentReturn, TError>,
		) => TNext | TError | undefined,
	): YakalaBuilder<TArgs, TOriginalReturn, UnwrapReturn<TNext>, TError>;

	/**
	 * Configures automatic retry behavior on failure.
	 *
	 * @param options - Retry configuration options
	 * @param options.retries - Maximum number of retry attempts
	 * @param options.delay - Delay in milliseconds between retries
	 * @param options.onRetry - Optional callback function called on each retry
	 * @returns A new builder with retry behavior configured
	 *
	 * @example
	 * ```ts
	 * yakala(fn)
	 *   .retry({
	 *     retries: 3,
	 *     delay: 1000,
	 *     onRetry: (err, attempt, max) => console.log(`Retry ${attempt}/${max}`)
	 *   })
	 * ```
	 */
	retry(options?: {
		retries: number;
		delay: number;
		onRetry?: (
			err: TError,
			currentAttempt: number,
			totalRetries: number,
		) => void;
	}): YakalaBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>;

	/**
	 * Adds circuit breaker pattern to prevent cascading failures.
	 *
	 * @param options - Circuit breaker configuration
	 * @param options.fallback - Function to provide fallback value when circuit is open
	 * @param options.threshold - Number of failures before opening circuit (default: 5)
	 * @param options.timeout - Time in ms before attempting to close circuit (default: 5000)
	 * @returns A new builder with circuit breaker configured
	 *
	 * @example
	 * ```ts
	 * yakala(fn)
	 *   .circuit({
	 *     fallback: () => "Default Value",
	 *     threshold: 3,
	 *     timeout: 10000
	 *   })
	 * ```
	 */
	circuit(options: {
		fallback: () =>
			| UnwrapReturn<TCurrentReturn>
			| Promise<UnwrapReturn<TCurrentReturn>>;
		threshold?: number;
		timeout?: number;
	}): YakalaBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>;

	/**
	 * Converts the function into an async stream with success/error/end handlers.
	 *
	 * @param handlers - Stream event handlers
	 * @param handlers.onSuccess - Called for each successful value
	 * @param handlers.onError - Called when an error occurs
	 * @param handlers.onEnd - Called when the stream ends
	 * @returns An async generator function that yields stream values
	 *
	 * @example
	 * ```ts
	 * const stream = yakala(fn)
	 *   .stream({
	 *     onSuccess: value => `Success: ${value}`,
	 *     onError: err => `Error: ${err.message}`,
	 *     onEnd: () => "Stream ended"
	 *   });
	 *
	 * for await (const item of stream()) {
	 *   console.log(item);
	 * }
	 * ```
	 */
	stream<TFallback = never>(handlers?: {
		onError?: (err: TError) => TFallback | Promise<TFallback>;
		onSuccess?: (
			value: UnwrapReturn<TCurrentReturn>,
		) =>
			| UnwrapReturn<TCurrentReturn>
			| TFallback
			| Promise<UnwrapReturn<TCurrentReturn> | TFallback>;
		onEnd?: () => TFallback | Promise<TFallback>;
	}): (
		...args: TArgs
	) => AsyncGenerator<UnwrapReturn<TCurrentReturn> | TFallback, void, unknown>;

	/**
	 * Executes the function and returns a Result object containing either value or error.
	 *
	 * @param args - Arguments to pass to the wrapped function
	 * @returns A Promise resolving to a Result object
	 *
	 * @example
	 * ```ts
	 * const { value, error } = await yakala(fn)
	 *   .handle("input");
	 *
	 * if (error) {
	 *   console.error(error);
	 * } else {
	 *   console.log(value);
	 * }
	 * ```
	 */
	handle(...args: TArgs): Promise<Result<UnwrapReturn<TCurrentReturn>, TError>>;
}

type BuilderState<
	TArgs extends unknown[],
	TCurrentReturn,
	TError extends Error,
> = {
	retryConfig: {
		retries: number;
		delay: number;
		onRetry?: (
			err: TError,
			currentAttempt: number,
			totalRetries: number,
		) => void;
	} | null;
	circuitConfig: {
		fallback: () =>
			| UnwrapReturn<TCurrentReturn>
			| Promise<UnwrapReturn<TCurrentReturn>>;
		threshold?: number;
		timeout?: number;
	} | null;
	pipeFns: ((ctx: PipeContext<TArgs, unknown, TError>) => unknown)[];
	errorTypeConfig: { name: string; options: Record<string, unknown> } | null;
	shouldThrow: boolean;
};

function ensureType<T>(value: unknown): T {
	return value as T;
}

function convertState<
	TArgs extends unknown[],
	TOld,
	TNew,
	TError extends Error,
>(state: BuilderState<TArgs, TOld, TError>): BuilderState<TArgs, TNew, TError> {
	return {
		...state,
		circuitConfig: state.circuitConfig
			? {
					...state.circuitConfig,
					fallback: state.circuitConfig.fallback as unknown as () =>
						| UnwrapReturn<TNew>
						| Promise<UnwrapReturn<TNew>>,
				}
			: null,
	};
}

/**
 * Creates a builder for safely handling function execution with error handling, retries, and transformations.
 *
 * @param targetFn - The function to wrap with error handling and other features
 * @returns A builder object for configuring error handling behavior
 *
 * @example
 * ```ts
 * // Basic usage
 * const safe = yakala(async (id: string) => {
 *   const user = await db.users.findById(id);
 *   return user;
 * });
 *
 * // Advanced usage with multiple features
 * const safe = yakala(fetchUser)
 *   .kind("UserNotFound", { code: "USER_404", status: 404 })
 *   .retry({ retries: 3, delay: 1000 })
 *   .pipe(ctx => {
 *     if (ctx.value) return { ...ctx.value, lastAccessed: new Date() };
 *   });
 *
 * // Handle the result
 * const { value, error } = await safe.handle("user-123");
 * ```
 */
export function yakala<TArgs extends unknown[], TReturn>(
	targetFn: (
		...args: TArgs
	) =>
		| TReturn
		| Promise<TReturn>
		| Iterable<UnwrapReturn<TReturn>>
		| Generator<UnwrapReturn<TReturn>, UnwrapReturn<TReturn>>
		| AsyncGenerator<UnwrapReturn<TReturn>, UnwrapReturn<TReturn>>,
): YakalaBuilder<TArgs, TReturn> {
	return createBuilder(targetFn);
}

function createBuilder<
	TArgs extends unknown[],
	TOriginalReturn,
	TCurrentReturn = TOriginalReturn,
	TError extends Error = Error,
>(
	targetFn: (
		...args: TArgs
	) =>
		| TOriginalReturn
		| Promise<TOriginalReturn>
		| Iterable<UnwrapReturn<TOriginalReturn>>
		| Generator<UnwrapReturn<TOriginalReturn>, UnwrapReturn<TOriginalReturn>>
		| AsyncGenerator<
				UnwrapReturn<TOriginalReturn>,
				UnwrapReturn<TOriginalReturn>
		  >,
	state: BuilderState<TArgs, TCurrentReturn, TError> = {
		retryConfig: null,
		circuitConfig: null,
		pipeFns: [],
		errorTypeConfig: null,
		shouldThrow: false,
	},
): YakalaBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError> {
	const normalizeError = (error: unknown): TError =>
		isError(error) ? (error as TError) : (new Error(String(error)) as TError);

	const applyPipes = (ctx: PipeContext<TArgs, unknown, TError>): unknown => {
		let result = ctx.value;
		let err = ctx.error;

		for (const fn of state.pipeFns) {
			const altered = fn({ ...ctx, value: result, error: err });
			if (altered !== undefined) {
				if (isError(altered)) {
					err = altered as TError;
					result = undefined;
				} else {
					result = altered;
					err = undefined;
				}
			}
		}
		return err || result;
	};

	const executeCore = async (...args: TArgs): Promise<unknown> => {
		try {
			const result = targetFn(...args);
			return result;
		} catch (error) {
			const normalized = normalizeError(error);
			throw normalized;
		}
	};

	const executeWithRetry = async (
		...args: TArgs
	): Promise<UnwrapReturn<TCurrentReturn>> => {
		if (!state.retryConfig)
			return ensureType<UnwrapReturn<TCurrentReturn>>(
				await executeCore(...args),
			);

		const { retries, delay, onRetry } = state.retryConfig;
		if (retries <= 0) throw new Error("Retries must be > 0");

		let attempt = 0;
		while (attempt <= retries) {
			try {
				return ensureType<UnwrapReturn<TCurrentReturn>>(
					await executeCore(...args),
				);
			} catch (error) {
				attempt++;
				const normalized = normalizeError(error);
				if (onRetry) onRetry(normalized as TError, attempt, retries);
				if (attempt >= retries) throw normalized;
				if (delay > 0)
					await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		throw new Error("Unreachable");
	};

	const executeWithCircuit = async (
		...args: TArgs
	): Promise<UnwrapReturn<TCurrentReturn>> => {
		if (!state.circuitConfig) return executeWithRetry(...args);

		const { fallback, threshold, timeout } = state.circuitConfig;
		const breaker = new CircuitBreaker<UnwrapReturn<TCurrentReturn>>(
			fallback as () =>
				| UnwrapReturn<TCurrentReturn>
				| Promise<UnwrapReturn<TCurrentReturn>>,
			{ threshold, timeout },
		);

		return breaker.exec(() => executeWithRetry(...args));
	};

	const composeHandler =
		() =>
		async (
			...args: TArgs
		): Promise<Result<UnwrapReturn<TCurrentReturn>, TError>> => {
			try {
				const result = await executeWithCircuit(...args);
				const ctx: PipeContext<TArgs, unknown, TError> = {
					value: result,
					args,
				};
				const altered = applyPipes(ctx);

				if (altered !== undefined && isError(altered)) throw altered;

				return {
					value: ensureType<UnwrapReturn<TCurrentReturn>>(altered ?? result),
					error: null,
				};
			} catch (error) {
				const normalized = normalizeError(error);
				const ctx: PipeContext<TArgs, TCurrentReturn, TError> = {
					error: normalized,
					args,
				};
				const altered = applyPipes(ctx);

				if (altered !== undefined && !isError(altered)) {
					return {
						value: ensureType<UnwrapReturn<TCurrentReturn>>(altered),
						error: null,
					};
				}

				const finalError = state.errorTypeConfig
					? createError(state.errorTypeConfig.name, normalized.message, {
							...state.errorTypeConfig.options,
							cause: normalized,
						})
					: normalized;

				if (state.shouldThrow) throw finalError;
				return { value: undefined, error: finalError as TError };
			}
		};

	return {
		kind: <TOpts extends Record<string, unknown>>(
			name: string,
			options: TOpts,
		) =>
			createBuilder<TArgs, TOriginalReturn, TCurrentReturn, Error & TOpts>(
				targetFn,
				{
					...state,
					errorTypeConfig: { name, options },
				} as unknown as BuilderState<TArgs, TCurrentReturn, Error & TOpts>,
			),

		throw: () =>
			createBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>(targetFn, {
				...state,
				shouldThrow: true,
			}),

		pipe: <TNext>(
			fn: (
				ctx: PipeContext<TArgs, TCurrentReturn, TError>,
			) => TNext | TError | undefined,
		) =>
			createBuilder<TArgs, TOriginalReturn, UnwrapReturn<TNext>, TError>(
				targetFn,
				{
					...convertState<TArgs, TCurrentReturn, UnwrapReturn<TNext>, TError>(
						state,
					),
					pipeFns: [
						...state.pipeFns,
						fn as (ctx: PipeContext<TArgs, unknown, TError>) => unknown,
					],
				},
			),

		retry: (options = { retries: 3, delay: 1000 }) =>
			createBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>(targetFn, {
				...state,
				retryConfig: options,
			}),

		circuit: (options) =>
			createBuilder<TArgs, TOriginalReturn, TCurrentReturn, TError>(targetFn, {
				...state,
				circuitConfig: {
					fallback: options.fallback as () =>
						| UnwrapReturn<TCurrentReturn>
						| Promise<UnwrapReturn<TCurrentReturn>>,
					threshold: options.threshold,
					timeout: options.timeout,
				},
			}),

		stream: <TFallback = never>(handlers?: {
			onError?: (err: TError) => TFallback | Promise<TFallback>;
			onSuccess?: (
				value: UnwrapReturn<TCurrentReturn>,
			) =>
				| UnwrapReturn<TCurrentReturn>
				| TFallback
				| Promise<UnwrapReturn<TCurrentReturn> | TFallback>;
			onEnd?: () => TFallback | Promise<TFallback>;
		}) =>
			async function* (
				...args: TArgs
			): AsyncGenerator<
				UnwrapReturn<TCurrentReturn> | TFallback,
				void,
				unknown
			> {
				let source: unknown;
				try {
					// Use library's execution logic for source creation (includes retry/circuit)
					source = await executeWithCircuit(...args);
				} catch (error) {
					if (handlers?.onError) {
						yield await handlers.onError(normalizeError(error) as TError);
					}
					return; // End gracefully after top-level error
				}

				// Resolve if it's a promise
				if (isPromise(source)) {
					source = await source;
				}

				// Helper to iterate over any streamable source as an async generator
				async function* iterateSource(
					src: unknown,
				): AsyncGenerator<unknown, void, unknown> {
					if (isReadableStream(src)) {
						const reader = src.getReader();
						try {
							while (true) {
								const { value, done } = await reader.read();
								if (done) break;
								yield value;
							}
						} finally {
							reader.releaseLock();
						}
					} else if (isAsyncIterable(src)) {
						const iterator = src[Symbol.asyncIterator]();
						while (true) {
							const { value, done } = await iterator.next();
							if (done) break;
							yield value;
						}
					} else if (isIterable(src)) {
						const iterator = src[Symbol.iterator]();
						while (true) {
							const { value, done } = iterator.next();
							if (done) break;
							yield await Promise.resolve(value);
						}
					} else if (src !== undefined) {
						// Plain value: yield once
						yield src;
					}
				}

				// Track attempts globally (start at 0 for initial)
				let globalAttempt = 0;
				const maxRetries = state.retryConfig?.retries ?? 0;
				const delay = state.retryConfig?.delay ?? 0;
				const onRetry = state.retryConfig?.onRetry;

				// Main iteration: process items, retry on fatal errors
				while (true) {
					try {
						for await (const value of iterateSource(source)) {
							try {
								const result =
									(await handlers?.onSuccess?.(
										value as UnwrapReturn<TCurrentReturn>,
									)) ?? value;
								yield result as UnwrapReturn<TCurrentReturn> | TFallback;
							} catch (error) {
								if (handlers?.onError) {
									yield await handlers.onError(normalizeError(error) as TError);
								}
								// Continue to next item
							}
						}
						break; // Natural end: exit loop
					} catch (error) {
						// Fatal mid-iteration error
						const normalized = normalizeError(error);
						globalAttempt++;

						// Only count/log as retry if after initial (attempt > 1)
						if (globalAttempt > 1 && onRetry) {
							onRetry(normalized as TError, globalAttempt - 1, maxRetries); // currentAttempt starts at 1
						}

						if (globalAttempt > maxRetries) {
							// Exhausted (initial + retries): yield final fallback and end
							if (handlers?.onError) {
								yield await handlers.onError(normalized as TError);
							}
							break;
						}

						// Delay and retry source
						if (delay > 0)
							await new Promise((resolve) => setTimeout(resolve, delay));
						try {
							source = await executeCore(...args); // Use core exec for retry (avoids nested retries)
							if (isPromise(source)) source = await source;
						} catch (retryError) {
							// If recreation fails, accumulate attempt
							globalAttempt++;
							const retryNormalized = normalizeError(retryError);
							if (globalAttempt > 1 && onRetry) {
								onRetry(
									retryNormalized as TError,
									globalAttempt - 1,
									maxRetries,
								);
							}
							if (globalAttempt > maxRetries) {
								if (handlers?.onError) {
									yield await handlers.onError(retryNormalized as TError);
								}
								break;
							}
						}
					}
				}

				if (handlers?.onEnd) {
					yield await handlers.onEnd();
				}
			},

		handle: (...args: TArgs) => composeHandler()(...args),
	};
}
