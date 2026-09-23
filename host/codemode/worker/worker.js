import { DynamicWorkerExecutor, generateTypesFromJsonSchema } from "@cloudflare/codemode";
import { createRequire } from 'module';

var require = createRequire(import.meta.url);
var module = { exports: {} };

async function handleGenerate(body) {
  const { tools, namespace = "codemode" } = body;
  const map = {};
  for (const t of tools) {
    map[t.name] = {
      description: t.description,
      inputSchema: t.inputSchema ?? { type: "object" }
    };
  }
  let block = generateTypesFromJsonSchema(map);
  if (namespace !== "codemode") {
    block = block.replace(
      /declare const codemode:/,
      `declare const ${namespace}:`
    );
  }
  return new Response(JSON.stringify({ apiBlock: block }), {
    headers: { "content-type": "application/json" }
  });
}

async function handleExecute(body, env) {
  const { code, toolNames, callbackUrl, namespace = "chrome", timeoutMs } = body;
  const budgetMs = timeoutMs ?? 180_000;

  // Record one entry per inner tool call (in invocation order, with the
  // wall-clock latency of the proxy roundtrip). This is purely at our
  // orchestration layer — codemode's executor sees the same fns it
  // would otherwise, just lightly wrapped.
  const calls = [];

  const fns = {};
  for (const name of toolNames) {
    fns[name] = async (args) => {
      const start = Date.now();
      try {
        const res = await fetch(`${callbackUrl}/tool/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(args ?? {})
        });
        const respBody = await res.json();
        if (!res.ok) {
          throw new Error(respBody?.error ?? `tool ${name} failed: ${res.status}`);
        }
        return respBody;
      } finally {
        calls.push({ tool: name, latencyMs: Date.now() - start });
      }
    };
  }

  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    timeout: budgetMs,
    globalOutbound: null
  });

  const t0 = Date.now();
  const result = await executor.execute(code, [{ name: namespace, fns }]);
  const latencyMs = Date.now() - t0;

  return new Response(JSON.stringify({ ...result, latencyMs, calls }), {
    headers: { "content-type": "application/json" }
  });
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const url = new URL(request.url);
    const body = await request.json();
    if (url.pathname === "/generate") return handleGenerate(body);
    if (url.pathname === "/execute") return handleExecute(body, env);
    return new Response("Not found", { status: 404 });
  }
};
