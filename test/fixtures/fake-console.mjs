// Stands in for Craft's console in tests: `node fake-console.mjs <mode> exec <php>`.
// It answers the way the real command does, with the query it was given echoed back so a test can see it arrived.
const [mode, , php] = process.argv.slice(2);

async function payload() {
	const inline = php.match(/base64_decode\("([^"]*)"\)/)?.[1];
	if (inline !== undefined) return inline;
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	return input;
}

if (mode === "deaf") {
	// exits without ever reading its input
	process.stdin.destroy();
	process.exit(0);
} else if (mode === "slow") {
	setTimeout(() => {}, 60_000);
} else {
	const { query } = JSON.parse(Buffer.from(await payload(), "base64").toString());
	if (mode === "flood") process.stdout.write("x".repeat(1024));
	process.stdout.write(`Output:\n<<<C2E${JSON.stringify({ data: { echo: query.length } })}C2E>>>\n`);
	// "crash" printed a complete result and then failed
	process.exitCode = mode === "crash" ? 3 : 0;
}
