import { createInterface } from "node:readline";

const scenario = process.argv[2];
const size = Number(process.argv[3]);
const write = (text: string) => new Promise<void>((resolve, reject) => {
  process.stdout.write(text, (error) => error ? reject(error) : resolve());
});
let first = true;
const input = createInterface({ input: process.stdin });
for await (const line of input) {
  const command = JSON.parse(line);
  if (first) {
    first = false;
    if (scenario === "invalid") {
      await write('{"type":"agent_end",NOT_JSON}\n');
    } else {
      const type = scenario === "other" ? "message_end" : "agent_end";
      const prefix = scenario === "type-last" ? '{"messages":["' : `{"type":"${type}","messages":["`;
      const suffix = scenario === "type-last" ? '"],"type":"agent_end"}' : '"]}';
      for (const part of [prefix.slice(0, 5), prefix.slice(5)]) {
        await write(part);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      let remaining = size - prefix.length - suffix.length;
      while (remaining > 0) {
        const length = Math.min(remaining, 64 * 1024);
        await write("x".repeat(length));
        remaining -= length;
      }
      await write(suffix);
      if (scenario === "no-lf") await new Promise(() => {});
      await write('\n{"type":"agent_settled","aborted":false}\n');
    }
  }
  await write(`${JSON.stringify({ type: "response", id: command.id, command: command.type,
    success: true, data: { sessionFile: "/test.jsonl" } })}\n`);
}
