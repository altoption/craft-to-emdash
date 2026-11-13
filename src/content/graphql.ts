// Talking to Craft's GraphQL API: two transports, and an index of the schema's types read by introspection.
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

export function httpExecute(endpoint: string, token: string | undefined): Execute {
	return async (query, variables) => {
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
			body: JSON.stringify({ query, variables }),
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

const ARG_LIMIT = 20_000;

/**
 * Runs queries inside Craft through its console (`<command> exec`), against a full-access schema.
 * It needs no GraphQL schema or token set up in Craft, only a working copy of the site: `php craft`, `ddev craft`…
 * Read-only: it executes queries, never mutations.
 */
export function consoleExecute(command: string[], cwd: string): Execute {
	const [bin, ...args] = command;
	if (!bin) throw new Error("The Craft console command is empty");
	return (query, variables) => {
		if (/^\s*mutation\b/.test(query)) throw new Error("craft-to-emdash only reads from Craft");
		// base64 keeps the query intact through the shell and PHP's string parsing
		const payload = Buffer.from(JSON.stringify({ query, variables: variables ?? {} })).toString("base64");
		// A long query would overflow the command line (about 32 KB on Windows), so it goes through standard input.
		const viaStdin = payload.length > ARG_LIMIT;
		const php =
			`$p=json_decode(base64_decode(${viaStdin ? "stream_get_contents(STDIN)" : `"${payload}"`}),true);` +
			`echo "<<<C2E".json_encode(Craft::$app->getGql()->executeQuery(\\craft\\helpers\\Gql::createFullAccessSchema(),$p["query"],$p["variables"]))."C2E>>>";`;
		return new Promise((resolve, reject) => {
			const child = execFile(bin, [...args, "exec", php], { cwd, maxBuffer: 1 << 30 }, (error, stdout, stderr) => {
				const json = stdout.match(/<<<C2E([\s\S]*)C2E>>>/)?.[1];
				if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
					return reject(new GraphqlRequestError(`Could not run "${bin}": the command was not found. Pass the command that runs Craft's console on this machine, e.g. --craft "php craft".`));
				}
				if (json === undefined || json === "null") {
					const hint = viaStdin ? " This query was sent through standard input; if your command runs Craft in a container, make sure it forwards input (docker exec -i)." : "";
					return reject(new Error(`\`${command.join(" ")} exec\` in ${cwd} gave no result${error ? `: ${error.message}` : ""}.${hint}\n${(stderr || stdout).slice(0, 500)}`));
				}
				try {
					resolve(toResult(JSON.parse(json)));
				} catch (e) {
					reject(e);
				}
			});
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
