// Talking to Craft's GraphQL API: two transports, and an index of the schema's types read by introspection.
import { Kind, parse } from "graphql";
import type { OperationDefinitionNode } from "graphql";
import { execFile } from "node:child_process";

export interface GraphqlError {
	message: string;
	path?: Array<string | number>;
}

export interface GraphqlResult {
	data: Record<string, unknown>;
	/** Field-level errors: GraphQL nulls the failing field and still answers the rest. */
	errors: GraphqlError[];
}

/** Runs one GraphQL request. Throws only when the response has no data at all. */
export type Execute = (query: string, variables?: Record<string, unknown>) => Promise<GraphqlResult>;

/** Craft rejected the query itself. Sending it again would get the same answer. */
export class GraphqlRequestError extends Error {}

/** Shapes a raw GraphQL response body, throwing when there is nothing usable in it. */
export function toResult(body: { data?: Record<string, unknown> | null; errors?: Array<{ message?: string; path?: Array<string | number> }> }): GraphqlResult {
	const errors = (body.errors ?? []).map((e): GraphqlError => ({ message: e.message ?? "unknown error", ...(e.path ? { path: e.path } : {}) }));
	if (!body.data) {
		const messages = [...new Set(errors.map((e) => e.message))];
		throw new GraphqlRequestError(`Craft rejected the query: ${messages.join("; ") || "no data in the response"}`);
	}
	return { data: body.data, errors };
}

export interface TransportOptions {
	/** How long one request may take before it is abandoned. Default: five minutes. */
	timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
/** The largest response read from Craft's console. A page of entries is a few megabytes at most. */
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** Above this the payload goes through standard input: a command line holds about 32 KB on Windows. */
const ARG_LIMIT = 20_000;

/**
 * Refuses anything but a single query. The tool only ever builds queries; this makes "read-only towards Craft" a
 * property of the transport rather than of the code that happens to call it. The document is parsed, since a
 * mutation can follow a comment, a comma or a fragment and no pattern on the text would be sure to see it.
 */
export function assertReadOnly(query: string): void {
	let operations: OperationDefinitionNode[];
	try {
		operations = parse(query).definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION);
	} catch (error) {
		throw new GraphqlRequestError(`Not a valid GraphQL document: ${error instanceof Error ? error.message : String(error)}`);
	}
	// exactly one, because no operation name is sent to choose between several
	if (operations.length !== 1 || operations[0]?.operation !== "query") {
		throw new GraphqlRequestError("craft-to-emdash only reads from Craft: a request must be a single query");
	}
}

export function httpExecute(endpoint: string, token: string | undefined, options: TransportOptions = {}): Execute {
	return async (query, variables) => {
		assertReadOnly(query);
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ query, variables }),
			signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
		});
		const text = await response.text();
		try {
			return toResult(JSON.parse(text));
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
			throw new Error(`${endpoint} answered ${response.status} with something other than JSON: ${text.slice(0, 200)}`);
		}
	};
}

/**
 * Runs queries inside Craft through its console (`<command> exec`), against a full-access schema.
 * It needs no GraphQL schema or token set up in Craft, only a working copy of the site: `php craft`, `ddev craft`…
 * That schema can also mutate, so every request passes assertReadOnly first.
 */
export function consoleExecute(command: string[], cwd: string, options: TransportOptions = {}): Execute {
	const [bin, ...args] = command;
	if (!bin) throw new Error("The Craft console command is empty");
	const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const shown = `\`${command.join(" ")} exec\``;
	return async (query, variables) => {
		assertReadOnly(query);
		// No shell is involved. Base64 keeps the query intact inside the PHP string literal, and through whatever
		// parsing a wrapper such as `ddev` or `docker exec` applies to its arguments.
		const payload = Buffer.from(JSON.stringify({ query, variables: variables ?? {} })).toString("base64");
		const viaStdin = payload.length > ARG_LIMIT;
		const php =
			`$p=json_decode(base64_decode(${viaStdin ? "stream_get_contents(STDIN)" : `"${payload}"`}),true);` +
			`echo "<<<C2E".json_encode(Craft::$app->getGql()->executeQuery(\\craft\\helpers\\Gql::createFullAccessSchema(),$p["query"],$p["variables"]))."C2E>>>";`;
		return new Promise((resolve, reject) => {
			const child = execFile(bin, [...args, "exec", php], { cwd, maxBuffer: MAX_OUTPUT_BYTES, timeout }, (error, stdout, stderr) => {
				// A process that failed is a failed request, even if it printed a complete-looking result first.
				if (error) {
					const failure = error as NodeJS.ErrnoException & { killed?: boolean };
					if (failure.code === "ENOENT") {
						return reject(new GraphqlRequestError(`Could not run "${bin}": the command was not found. Pass the command that runs Craft's console on this machine, e.g. --craft "php craft".`));
					}
					if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
						return reject(new GraphqlRequestError(`${shown} answered with more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB. Ask for fewer entries per request with --page-size.`));
					}
					if (failure.killed) return reject(new Error(`${shown} did not finish within ${Math.round(timeout / 1000)} seconds. Raise the limit with --timeout, or lower --page-size.`));
					return reject(new Error(`${shown} in ${cwd} failed: ${error.message.split("\n")[0]}\n${(stderr || stdout).slice(0, 500)}`));
				}
				const json = stdout.match(/<<<C2E([\s\S]*)C2E>>>/)?.[1];
				if (json === undefined || json === "null") {
					const hint = viaStdin ? " This query was sent through standard input; if your command runs Craft in a container, make sure it forwards input (docker exec -i)." : "";
					return reject(new Error(`${shown} in ${cwd} gave no result.${hint}\n${(stderr || stdout).slice(0, 500)}`));
				}
				try {
					resolve(toResult(JSON.parse(json)));
				} catch (e) {
					reject(e);
				}
			});
			// The command may exit, or close its input, while a large query is still being written to it.
			child.stdin?.on("error", (error) => reject(new Error(`${shown} stopped reading the query: ${error.message}`)));
			child.stdin?.end(viaStdin ? payload : undefined);
		});
	};
}

/** Retries a failed request, waiting 1s then 2s… A request that keeps failing still throws. */
export function withRetry(execute: Execute, attempts = 3, onRetry?: (attempt: number, error: Error) => void): Execute {
	return async (query, variables) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await execute(query, variables);
			} catch (error) {
				if (attempt >= attempts || error instanceof GraphqlRequestError) throw error;
				onRetry?.(attempt, error instanceof Error ? error : new Error(String(error)));
				await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
			}
		}
	};
}

interface RawTypeRef {
	kind: string;
	name: string | null;
	ofType?: RawTypeRef | null;
}

export interface FieldType {
	/** The named type once lists and non-nulls are unwrapped. */
	name: string;
	kind: "SCALAR" | "ENUM" | "OBJECT" | "INTERFACE" | "UNION" | string;
	list: boolean;
	/** True when the field cannot be selected without passing an argument. */
	requiresArgs: boolean;
}

export interface TypeIndex {
	/** type name -> field name -> the field's type */
	fields: Map<string, Map<string, FieldType>>;
	/** union or interface name -> the object types it can be */
	possible: Map<string, Set<string>>;
}

const TYPE_REF = "kind name ofType { kind name ofType { kind name ofType { kind name } } }";
export const INTROSPECTION_QUERY = `{ __schema { types { name kind possibleTypes { name } fields { name args { type { kind } defaultValue } type { ${TYPE_REF} } } } } }`;

function unwrap(ref: RawTypeRef): { name: string; kind: string; list: boolean } {
	let list = false;
	let current: RawTypeRef | null | undefined = ref;
	while (current && (current.kind === "NON_NULL" || current.kind === "LIST")) {
		if (current.kind === "LIST") list = true;
		current = current.ofType;
	}
	return { name: current?.name ?? "", kind: current?.kind ?? "", list };
}

export async function introspect(execute: Execute): Promise<TypeIndex> {
	const { data } = await execute(INTROSPECTION_QUERY);
	const types = (data["__schema"] as { types: Array<{ name: string; possibleTypes: Array<{ name: string }> | null; fields: Array<{ name: string; args: Array<{ type: { kind: string }; defaultValue: string | null }>; type: RawTypeRef }> | null }> }).types;
	const index: TypeIndex = { fields: new Map(), possible: new Map() };
	for (const type of types) {
		if (type.possibleTypes) index.possible.set(type.name, new Set(type.possibleTypes.map((t) => t.name)));
		if (!type.fields) continue;
		index.fields.set(
			type.name,
			new Map(
				type.fields.map((f) => [
					f.name,
					{ ...unwrap(f.type), requiresArgs: f.args.some((a) => a.type.kind === "NON_NULL" && a.defaultValue === null) },
				]),
			),
		);
	}
	return index;
}
