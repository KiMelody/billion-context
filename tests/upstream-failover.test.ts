import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { REPLAY_MAX_ATTEMPTS } from "../src/fetch-util.ts";
import { upstreamProxyFailoverMode } from "../src/knobs.ts";
import {
    _resetUpstreamProxyForTest,
    fetchWithUpstreamProxyFailover,
    getUpstreamConnectionStatus,
    proxyDispatcher,
    recordUpstreamConnection,
    upstreamFailoverEgress,
} from "../src/upstream-proxy.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// #360: never pick a fixed port — reserve one from the OS and close it, so the
// test gets a genuinely dead port on any platform (Windows included).
async function deadPort(): Promise<number> {
    const server = http.createServer();
    await listen(server);
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

const root = mkdtempSync(path.join(tmpdir(), "upstream-failover-"));
const cfgFile = path.join(root, "billion-context.json");
const previousConfigFile = process.env.BILI_CONFIG_FILE;

function setConfig(obj: unknown): void {
    writeFileSync(cfgFile, JSON.stringify(obj, null, 2), "utf8");
    process.env.BILI_CONFIG_FILE = cfgFile;
}

function clearConfig(): void {
    process.env.BILI_CONFIG_FILE = "/nonexistent/bili-failover-test-config.json";
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
    const saved: Array<[string, string | undefined]> = [];
    for (const [k, v] of Object.entries(vars)) {
        saved.push([k, process.env[k]]);
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    try {
        fn();
    } finally {
        for (const [k, v] of saved) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    }
}

/** Harness for the transport tests: zero replay backoff, no knob env, a fresh
 *  dispatcher cache, and a global-fetch counter so tests can prove exactly how
 *  many wire attempts were made (3 ladder + 1 failover, never more). */
async function withFastReplay(fn: (calls: { n: number }) => Promise<void>): Promise<void> {
    clearConfig();
    const prevBase = process.env.BILI_REPLAY_RETRY_BASE_MS;
    const prevFailover = process.env.BILI_UPSTREAM_PROXY_FAILOVER;
    delete process.env.BILI_UPSTREAM_PROXY_FAILOVER;
    process.env.BILI_REPLAY_RETRY_BASE_MS = "0";
    _resetUpstreamProxyForTest();
    const origFetch = globalThis.fetch;
    const calls = { n: 0 };
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
        calls.n += 1;
        return origFetch(...args);
    }) as typeof fetch;
    try {
        await fn(calls);
    } finally {
        globalThis.fetch = origFetch;
        if (prevBase === undefined) delete process.env.BILI_REPLAY_RETRY_BASE_MS;
        else process.env.BILI_REPLAY_RETRY_BASE_MS = prevBase;
        if (prevFailover === undefined) delete process.env.BILI_UPSTREAM_PROXY_FAILOVER;
        else process.env.BILI_UPSTREAM_PROXY_FAILOVER = prevFailover;
        _resetUpstreamProxyForTest();
    }
}

test("failover off by default: a dead proxy exhausts the replay ladder and the direct target is never touched", async () => {
    await withFastReplay(async (calls) => {
        let upstreamHits = 0;
        const upstream = http.createServer((_req, res) => {
            upstreamHits += 1;
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("direct-ok");
        });
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        const proxyPort = await deadPort();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        try {
            const logs: Array<{ level: string; msg: string }> = [];
            let caught: unknown;
            await assert.rejects(
                fetchWithUpstreamProxyFailover(
                    `http://127.0.0.1:${upstreamPort}/v1/messages`,
                    { method: "POST", body: "{}", dispatcher: proxyDispatcher(proxyUrl) },
                    5000,
                    undefined,
                    undefined,
                    proxyUrl,
                    false,
                    (level, msg) => logs.push({ level, msg }),
                ),
                (error: unknown) => {
                    caught = error;
                    return true;
                },
            );
            assert.equal(upstreamHits, 0, "direct target must not be touched while failover is off");
            assert.equal(calls.n, REPLAY_MAX_ATTEMPTS, "ladder runs to exhaustion, no extra attempt");
            assert.equal(logs.length, 0, "no failover logging when the knob is off");
            assert.equal(upstreamFailoverEgress(caught), undefined, "no failover → no egress stamp; callers keep proxyUrl");
        } finally {
            upstream.closeAllConnections();
            await close(upstream);
        }
    });
});

test("opt-in failover: dead proxy port + live direct upstream succeeds with egressProxy undefined", async () => {
    await withFastReplay(async (calls) => {
        let upstreamHits = 0;
        const upstream = http.createServer((_req, res) => {
            upstreamHits += 1;
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("direct-ok");
        });
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/messages`;
        const proxyPort = await deadPort();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        try {
            const logs: Array<{ level: string; msg: string }> = [];
            const result = await fetchWithUpstreamProxyFailover(
                upstreamUrl,
                { method: "POST", body: "{}", dispatcher: proxyDispatcher(proxyUrl) },
                5000,
                undefined,
                undefined,
                proxyUrl,
                true,
                (level, msg) => logs.push({ level, msg }),
            );
            assert.equal(result.response.status, 200);
            assert.equal(await result.response.text(), "direct-ok");
            result.clearTimer();
            assert.equal(result.egressProxy, undefined, "the successful send rode no proxy");
            assert.equal(upstreamHits, 1, "exactly one direct attempt after the ladder");
            assert.equal(calls.n, REPLAY_MAX_ATTEMPTS + 1, "full proxied ladder plus one direct failover");
            assert.ok(logs.some((e) => e.msg.includes("one direct failover attempt")));
            assert.ok(logs.some((e) => e.msg.includes("succeeded via direct failover")));
            // relay contract: the status snapshot records the REAL egress
            recordUpstreamConnection(upstreamUrl, result.egressProxy);
            const status = getUpstreamConnectionStatus();
            assert.equal(status.connected, true);
            assert.equal(status.proxy, undefined, "snapshot shows no proxy after a direct failover");
        } finally {
            upstream.closeAllConnections();
            await close(upstream);
        }
    });
});

test("opt-in failover without a proxy in the path behaves exactly like off", async () => {
    await withFastReplay(async (calls) => {
        const upstreamPort = await deadPort();
        const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/messages`;
        const logs: Array<{ level: string; msg: string }> = [];
        await assert.rejects(
            fetchWithUpstreamProxyFailover(
                upstreamUrl,
                { method: "POST", body: "{}" },
                5000,
                undefined,
                undefined,
                undefined,
                true,
                (level, msg) => logs.push({ level, msg }),
            ),
        );
        assert.equal(calls.n, REPLAY_MAX_ATTEMPTS, "no failover attempt without a proxy");
        assert.equal(logs.length, 0);
    });
});

test("both paths dead: the direct error surfaces and the log names the both-paths state", async () => {
    await withFastReplay(async (calls) => {
        const upstreamPort = await deadPort();
        const upstreamUrl = `http://127.0.0.1:${upstreamPort}/v1/messages`;
        const proxyPort = await deadPort();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        const logs: Array<{ level: string; msg: string }> = [];
        let caught: unknown;
        await assert.rejects(
            fetchWithUpstreamProxyFailover(
                upstreamUrl,
                { method: "POST", body: "{}", dispatcher: proxyDispatcher(proxyUrl) },
                5000,
                undefined,
                undefined,
                proxyUrl,
                true,
                (level, msg) => logs.push({ level, msg }),
            ),
            (error: unknown) => {
                caught = error;
                return String((error as Error & { cause?: Error }).cause?.message ?? "").includes("ECONNREFUSED");
            },
        );
        assert.deepEqual(upstreamFailoverEgress(caught), { proxy: undefined }, "the failed send rode direct — relay must attribute it to the direct path");
        assert.equal(calls.n, REPLAY_MAX_ATTEMPTS + 1, "full proxied ladder plus one direct attempt");
        assert.ok(
            logs.some((e) => e.level === "warn" && e.msg.includes("unreachable with and without proxy")),
            `log must name the both-paths failure, got: ${logs.map((e) => e.msg).join(" | ")}`,
        );
    });
});

test("external abort is a non-fail-fast death: no replay, no failover", async () => {
    await withFastReplay(async (calls) => {
        const upstream = http.createServer((_req, res) => {
            res.writeHead(200, { "content-type": "text/plain" });
            res.end("direct-ok");
        });
        await listen(upstream);
        const upstreamPort = (upstream.address() as { port: number }).port;
        const proxyPort = await deadPort();
        const proxyUrl = `http://127.0.0.1:${proxyPort}`;
        const controller = new AbortController();
        controller.abort();
        try {
            const logs: Array<{ level: string; msg: string }> = [];
            await assert.rejects(
                fetchWithUpstreamProxyFailover(
                    `http://127.0.0.1:${upstreamPort}/v1/messages`,
                    { method: "POST", body: "{}", dispatcher: proxyDispatcher(proxyUrl) },
                    5000,
                    controller.signal,
                    undefined,
                    proxyUrl,
                    true,
                    (level, msg) => logs.push({ level, msg }),
                ),
            );
            assert.equal(calls.n, 1, "a client abort is never replayed or failed over");
            assert.equal(logs.length, 0);
        } finally {
            upstream.closeAllConnections();
            await close(upstream);
        }
    });
});

test("knob upstreamProxyFailoverMode: default off, env > file, only \"direct\" enables", () => {
    clearConfig();
    withEnv({ BILI_UPSTREAM_PROXY_FAILOVER: undefined }, () => {
        assert.equal(upstreamProxyFailoverMode(), undefined, "no env, no file → off");
    });
    withEnv({ BILI_UPSTREAM_PROXY_FAILOVER: "direct" }, () => {
        assert.equal(upstreamProxyFailoverMode(), "direct");
    });
    withEnv({ BILI_UPSTREAM_PROXY_FAILOVER: "  DIRECT  " }, () => {
        assert.equal(upstreamProxyFailoverMode(), "direct", "trim + case-insensitive");
    });
    for (const junk of ["off", "", "junk", "DIRECT-ONLY", "1"]) {
        withEnv({ BILI_UPSTREAM_PROXY_FAILOVER: junk }, () => {
            assert.equal(upstreamProxyFailoverMode(), undefined, `env ${JSON.stringify(junk)} → off`);
        });
    }
    withEnv({ BILI_UPSTREAM_PROXY_FAILOVER: undefined }, () => {
        setConfig({ network: { upstreamProxyFailover: "direct" } });
        assert.equal(upstreamProxyFailoverMode(), "direct", "file tier applies when env is unset");
        setConfig({ network: { upstreamProxyFailover: "off" } });
        assert.equal(upstreamProxyFailoverMode(), undefined);
        setConfig({ network: { upstreamProxyFailover: "garbage" } });
        assert.equal(upstreamProxyFailoverMode(), undefined, "unknown file value falls back to off");
        setConfig({ network: { upstreamProxyFailover: 1 } });
        assert.equal(upstreamProxyFailoverMode(), undefined, "non-string file value → off");
        setConfig({ network: { upstreamProxyFailover: "direct" } });
        process.env.BILI_UPSTREAM_PROXY_FAILOVER = "junk";
        assert.equal(upstreamProxyFailoverMode(), undefined, "a SET env var owns the knob over the file");
        process.env.BILI_UPSTREAM_PROXY_FAILOVER = "DIRECT";
        assert.equal(upstreamProxyFailoverMode(), "direct");
        delete process.env.BILI_UPSTREAM_PROXY_FAILOVER;
    });
    clearConfig();
});

test("teardown", () => {
    clearConfig();
    _resetUpstreamProxyForTest();
    if (previousConfigFile === undefined) delete process.env.BILI_CONFIG_FILE;
    else process.env.BILI_CONFIG_FILE = previousConfigFile;
    rmSync(root, { recursive: true, force: true });
});
