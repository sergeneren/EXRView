// Main-thread side of the decode worker: owns the decoded-plane cache and a
// job queue. One job runs at a time, so a user request (queued urgently)
// waits at most for the job in flight; background prefetches queue behind.

export class Decoder {
  /** urls: { glue, core, wasm } webview URLs of exrview.js, decoder-core.js, exrview.wasm */
  static async create(urls) {
    const get = async (url) => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`failed to load ${url}: ${r.status}`);
      return r;
    };
    const [glue, core, wasm] = await Promise.all([
      get(urls.glue).then((r) => r.text()),
      get(urls.core).then((r) => r.text()),
      get(urls.wasm).then((r) => r.arrayBuffer()),
    ]);
    // Webview resources are cross-origin for workers, so the worker runs
    // from a blob and gets the wasm bytes instead of fetching them.
    const blob = new Blob([glue, "\n;\n", core], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const decoder = new Decoder(new Worker(url));
    URL.revokeObjectURL(url);
    await decoder.call({ type: "init", wasm }, [wasm]);
    return decoder;
  }

  constructor(worker) {
    this.worker = worker;
    this.nextId = 1;
    this.pending = new Map(); // message id -> { resolve, reject }
    this.reset();
    worker.onmessage = ({ data }) => {
      const p = this.pending.get(data.id);
      if (!p) return;
      this.pending.delete(data.id);
      if (data.error !== undefined) p.reject(new Error(data.error));
      else p.resolve(data.result);
    };
    worker.onerror = (e) => {
      const err = new Error(`decode worker failed: ${e.message}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    /** Called when queue progress changes: ({ done, total }) for prefetches. */
    this.onProgress = null;
  }

  reset() {
    this.generation = (this.generation ?? 0) + 1;
    this.planes = new Map(); // "part:channel" -> Float32Array
    this.cryptos = new Map(); // cryptomatte name -> flattened result
    this.bytes = 0;
    for (const job of this.queue ?? []) job.reject(new Error("superseded"));
    this.queue = [];
    this.jobs = new Map(); // key -> queued or running job
    this.prefetch = { done: 0, total: 0 };
  }

  call(msg, transfer = []) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...msg, id }, transfer);
    });
  }

  /** Opens a file (transfers `buffer`) and drops everything cached. */
  async open(buffer) {
    this.reset();
    return this.call({ type: "open", buffer }, [buffer]);
  }

  hasPlanes(part, channels) {
    return channels.every((c) => this.planes.has(`${part}:${c}`));
  }

  /** Cached planes; call after hasPlanes or a resolved request. */
  getPlanes(part, channels) {
    return channels.map((c) => this.planes.get(`${part}:${c}`));
  }

  hasCrypto(name) {
    return this.cryptos.has(name);
  }

  getCrypto(name) {
    return this.cryptos.get(name);
  }

  /** Decodes (if needed) channels of a part. */
  requestPlanes(part, channels, urgent = false) {
    return this.enqueue(
      {
        key: `P:${part}:${channels.join(",")}`,
        // Re-check at run time: a prefetch may have decoded them meanwhile.
        prepare: () => {
          const missing = channels.filter((c) => !this.planes.has(`${part}:${c}`));
          return missing.length ? { msg: { type: "decode", part, channels: missing }, missing } : null;
        },
        store: (planes, { missing }) =>
          planes.forEach((p, k) => {
            this.planes.set(`${part}:${missing[k]}`, p);
            this.bytes += p.byteLength;
          }),
      },
      urgent,
    );
  }

  /** Flattens (if needed) a Cryptomatte described by buildLayers. */
  requestCrypto(crypto, urgent = false) {
    return this.enqueue(
      {
        key: `C:${crypto.name}`,
        prepare: () => (this.cryptos.has(crypto.name) ? null : { msg: { type: "crypto", ranks: crypto.ranks } }),
        store: (flat) => {
          this.cryptos.set(crypto.name, flat);
          for (const p of [...flat.planes, ...flat.ranks.flatMap((r) => [r.id, r.cov])]) this.bytes += p.byteLength;
        },
      },
      urgent,
    );
  }

  /**
   * Queues background work: [{ estimate (bytes), run: (decoder) => promise }].
   * Stops adding once the estimated total would pass `budget` bytes.
   */
  prefetchAll(tasks, budget) {
    let planned = this.bytes;
    const accepted = [];
    for (const t of tasks) {
      if (planned + t.estimate > budget) continue;
      planned += t.estimate;
      accepted.push(t);
    }
    this.prefetch = { done: 0, total: accepted.length, skipped: tasks.length - accepted.length };
    const generation = this.generation;
    for (const t of accepted)
      t.run(this)
        .catch(() => {})
        .finally(() => {
          if (generation !== this.generation) return;
          this.prefetch.done++;
          this.onProgress?.(this.prefetch);
        });
    this.onProgress?.(this.prefetch);
  }

  enqueue(spec, urgent) {
    let job = this.jobs.get(spec.key);
    if (!job) {
      job = { ...spec, generation: this.generation };
      job.promise = new Promise((resolve, reject) => {
        job.resolve = resolve;
        job.reject = reject;
      });
      this.jobs.set(spec.key, job);
      if (urgent) this.queue.unshift(job);
      else this.queue.push(job);
    } else if (urgent) {
      const i = this.queue.indexOf(job);
      if (i > 0) {
        this.queue.splice(i, 1);
        this.queue.unshift(job);
      }
    }
    this.pump();
    return job.promise;
  }

  async pump() {
    if (this.running || !this.queue.length) return;
    const job = this.queue.shift();
    this.running = job;
    try {
      const prepared = job.prepare();
      if (prepared) {
        const result = await this.call(prepared.msg);
        if (job.generation !== this.generation) throw new Error("superseded");
        job.store(result, prepared);
      }
      job.resolve();
    } catch (e) {
      job.reject(e);
    } finally {
      if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
      this.running = null;
      this.pump();
    }
  }
}
