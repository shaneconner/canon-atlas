/* Embedding generation: the one network-touching command in the atlas.
   Everything else is deterministic and offline; this writes the embeddings.json
   that build, serve, and the app consume, and it only runs when asked.

   The default provider is a local Ollama, so by default nothing leaves the
   machine; OpenAI is the hosted alternative. Vectors are keyed by root-relative
   path. A __meta__ entry records the model and a content hash per document
   (the reader's parseVectors skips it, since its value is not a numeric array),
   so a rerun embeds only what changed and a model switch re-embeds everything.
   Writes are atomic and land after every batch, so an interrupted run keeps
   its progress and resumes where it stopped. */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { scanCorpus } from "./scan.mjs";

const BATCH = 16;
const MAX_CHARS = 8000;

const PROVIDERS = {
  ollama: {
    model: "nomic-embed-text",
    url: () => (process.env.OLLAMA_HOST || "http://127.0.0.1:11434") + "/api/embed",
    headers: () => ({ "Content-Type": "application/json" }),
    body: (model, texts) => ({ model, input: texts }),
    vectors: (json) => json.embeddings,
    hint: "is Ollama running? set OLLAMA_HOST, or use -m openai:text-embedding-3-small",
  },
  openai: {
    model: "text-embedding-3-small",
    url: () => (process.env.OPENAI_BASE_URL || "https://api.openai.com") + "/v1/embeddings",
    headers: () => {
      if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
      return { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` };
    },
    body: (model, texts) => ({ model, input: texts }),
    vectors: (json) => json.data.map((d) => d.embedding),
    hint: "check OPENAI_API_KEY and OPENAI_BASE_URL",
  },
};

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

/* Six decimals is well past what cosine distance can feel, and it keeps the
   JSON a third the size a full double would write at high dimensions. */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

function atomicWrite(file, content) {
  const tmp = file + ".atlas-tmp-" + process.pid;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/* Node's fetch gives up on any response whose headers take five minutes, and
   a batch on a big local model legitimately thinks longer than that. Plain
   node:http imposes no deadline: the model answers when it answers. */
function post(url, headers, body) {
  return new Promise((fulfil, reject) => {
    const u = new URL(url);
    const req = (u.protocol === "https:" ? httpsRequest : httpRequest)(
      u,
      { method: "POST", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => fulfil({ status: res.statusCode, text }));
      }
    );
    req.on("error", reject);
    req.end(body);
  });
}

/* modelArg is provider or provider:model, e.g. "ollama", "openai:text-embedding-3-large".
   Without one, a corpus that was embedded before keeps its recorded model, so a
   bare rerun never silently switches models and re-embeds the world. */
export async function embed(rootArg, modelArg, log = () => {}) {
  const root = resolve(rootArg || ".");
  const config = loadConfig(root);

  const file = join(root, config.embeddings);
  let store = {};
  if (existsSync(file)) {
    try {
      store = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      store = {};
    }
  }

  const spec = modelArg || (store.__meta__ && store.__meta__.model) || "ollama";
  const sep = spec.indexOf(":");
  const providerName = sep < 0 ? spec : spec.slice(0, sep);
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`unknown provider: ${providerName}; use ollama[:model] or openai[:model]`);
  }
  const model = sep < 0 ? provider.model : spec.slice(sep + 1);
  const modelId = providerName + ":" + model;

  const docs = scanCorpus(root, config);
  if (!docs.length) throw new Error(`no markdown documents under ${root}`);

  const meta =
    store.__meta__ && store.__meta__.model === modelId
      ? store.__meta__
      : { model: modelId, hashes: {} };
  store.__meta__ = meta;

  // What needs embedding: new documents, changed documents, or everything
  // after a model switch. Unchanged documents keep their stored vectors.
  const current = Object.create(null);
  const pending = [];
  for (const d of docs) {
    const text = (d.title + "\n\n" + d.body).slice(0, MAX_CHARS);
    const hash = sha(text);
    current[d.path] = true;
    if (meta.hashes[d.path] === hash && Array.isArray(store[d.path])) continue;
    pending.push({ path: d.path, text, hash });
  }

  // Vectors for documents that no longer exist come out.
  let removed = 0;
  for (const key of Object.keys(store)) {
    if (key !== "__meta__" && !current[key]) {
      delete store[key];
      delete meta.hashes[key];
      removed++;
    }
  }

  let done = 0;
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    let res;
    try {
      res = await post(
        provider.url(),
        provider.headers(),
        JSON.stringify(provider.body(model, batch.map((b) => b.text)))
      );
    } catch (e) {
      throw new Error(`${providerName} unreachable at ${provider.url()} (${e.message}); ${provider.hint}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`${providerName} answered ${res.status}: ${res.text.slice(0, 300)}`);
    }
    const vecs = provider.vectors(JSON.parse(res.text));
    if (!Array.isArray(vecs) || vecs.length !== batch.length) {
      throw new Error(`${providerName} returned ${vecs ? vecs.length : "no"} vectors for ${batch.length} documents`);
    }
    batch.forEach((b, j) => {
      store[b.path] = vecs[j].map(round6);
      meta.hashes[b.path] = b.hash;
    });
    atomicWrite(file, JSON.stringify(store));
    done += batch.length;
    log(`${done}/${pending.length}`);
  }
  if (!pending.length && removed) atomicWrite(file, JSON.stringify(store));

  return {
    file,
    model: modelId,
    documents: docs.length,
    embedded: pending.length,
    reused: docs.length - pending.length,
    removed,
  };
}
