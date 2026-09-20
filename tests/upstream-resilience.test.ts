import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { _resetFetchUtilForTest, isNetworkClassUpstreamError } from "../src/fetch-util.ts";
import { _resetUpstreamProxyForTest, fetchUpstreamResilient } from "../src/upstream-proxy.ts";
import { loadOptions, parseUpstreamProxyFailover } from "../src/config.ts";

function listen(server: http.Server): Promise<void> {
    server.listen(0, "127.0.0.1");
    return once(server, "listening").then(() => undefined);
}

function close(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

/** A freshly-closed loopback port: connect() gets ECONNREFUSED immediately. */
async function freePort(): Promise<number> {
    const server = http.createServer();
    await listen(server);
    const port = (server.address() as { port: number }).port;
    await close(server);
    return port;
}

function errnoError(message: string, code: string): Error {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    return error;
}

test("isNetworkClassUpstreamError classifies transport failures, not HTTP/abort/DNS ones", () => {
    assert.equal(isNetworkClassUpstreamError(errnoError("connect ECONNREFUSED 127.0.0.1:1", "ECONNREFUSED")), true);
    assert.equal(isNetworkClassUpstreamError(errnoError("read ECONNRESET", "ECONNRESET")), true);
    assert.equal(isNetworkClassUpstreamError(errnoError("connect ETIMEDOUT", "ETIMEDOUT")), true);
    assert.equal(isNetworkClassUpstreamError(errnoError("socket error", "UND_ERR_SOCKET")), true);
    assert.equal(isNetworkClassUpstreamError(errnoError("connect timeout", "UND_ERR_CONNECT_TIMEOUT")), true);
    // The exact incident signature (#1041): TLS dropped before establishment.
    assert.equal(
        isNetworkClassUpstreamError(new Error("Client network socket disconnected before secure TLS connection was established")),
        true,
    );
    assert.equal(isNetworkClassUpstreamError(new Error("socket hang up")), true);
    // undici wraps real causes in `TypeError: fetch failed`.
    const wrapped = new TypeError("fetch failed", { cause: errnoError("read ECONNRESET", "ECONNRESET") });
    assert.equal(isNetworkClassUpstreamError(wrapped), true);
    // NOT network-class: watchdog/client abort, DNS miss, bare wrapper.
    assert.equal(isNetworkClassUpstreamError(errnoError("This operation was aborted", "ABORT_ERR")), false);
    assert.equal(isNetworkClassUpstreamError(errnoError("getaddrinfo ENOTFOUND relay.invalid", "ENOTFOUND")), false);
    assert.equal(isNetworkClassUpstreamError(new TypeError("fetch failed")), false);
    assert.equal(isNetworkClassUpstreamError(undefined), false);
});

test("#1041: an ECONNRESET-class forward failure is retried and the second attempt succeeds", async () => {
    _resetUpstreamProxyForTest();
    _resetFetchUtilForTest();
    let requests = 0;
    const upstream = http.createServer((req, res) => {
        requests++;
        req.resume();
        req.on("end", () => {
            if (requests === 1) {
                req.socket.destroy();
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end('{"ok":true}');
        });
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const result = await fetchUpstreamResilient(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            { method: "POST", body: "{}" },
            { maxRetries: 2, baseDelayMs: 1 },
        );
        assert.equal(result.response.status, 200);
        assert.equal(await result.response.text(), '{"ok":true}');
        assert.equal(result.attempts, 2);
        assert.equal(result.failoverDirect, false);
        assert.equal(requests, 2);
        result.clearTimer();
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetUpstreamProxyForTest();
        _resetFetchUtilForTest();
    }
});

test("#1041: no retry once response bytes are flowing — a mid-body reset surfaces as a stream error", async () => {
    _resetUpstreamProxyForTest();
    _resetFetchUtilForTest();
    let requests = 0;
    const upstream = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: partial\n\n");
        setTimeout(() => res.destroy(), 30);
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const result = await fetchUpstreamResilient(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            { method: "POST", body: "{}" },
            { maxRetries: 2, baseDelayMs: 1 },
        );
        // Headers arrived: the response is returned as-is and never re-fetched.
        assert.equal(result.response.status, 200);
        assert.equal(result.attempts, 1);
        try {
            await assert.rejects(result.response.text());
        } finally {
            result.clearTimer(); // #411: never leak the 12-min idle timer on a broken body
        }
        await new Promise((resolve) => setTimeout(resolve, 80));
        assert.equal(requests, 1, "mid-stream failure must not trigger a second request");
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetUpstreamProxyForTest();
        _resetFetchUtilForTest();
    }
});

test("#1041: HTTP error statuses belong to fetchWithRetry's tier, not this ladder", async () => {
    _resetUpstreamProxyForTest();
    _resetFetchUtilForTest();
    let requests = 0;
    const upstream = http.createServer((_req, res) => {
        requests++;
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"boom"}');
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    try {
        const result = await fetchUpstreamResilient(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            { method: "POST", body: "{}" },
            { maxRetries: 2, baseDelayMs: 1 },
        );
        assert.equal(result.response.status, 500);
        assert.equal(result.attempts, 1);
        result.clearTimer();
        assert.equal(requests, 1);
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetUpstreamProxyForTest();
        _resetFetchUtilForTest();
    }
});

test("#1041: without opt-in, a dead proxy exhausts its attempts and never touches the target directly", async () => {
    _resetUpstreamProxyForTest();
    _resetFetchUtilForTest();
    let requests = 0;
    const upstream = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200);
        res.end("{}");
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const deadProxyPort = await freePort();
    try {
        await assert.rejects(
            fetchUpstreamResilient(
                `http://127.0.0.1:${port}/v1/chat/completions`,
                { method: "POST", body: "{}" },
                { proxyUrl: `http://127.0.0.1:${deadProxyPort}`, maxRetries: 1, baseDelayMs: 1 },
            ),
            (error: Error) => {
                assert.match(error.message, /upstream request failed/);
                assert.match(error.message, new RegExp(`upstream proxy http://127\\.0\\.0\\.1:${deadProxyPort}/? failed`));
                assert.match(error.message, /after 2 attempt\(s\)/);
                return true;
            },
        );
        assert.equal(requests, 0, "direct failover must not run unless opted in");
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetUpstreamProxyForTest();
        _resetFetchUtilForTest();
    }
});

test("#1041: with failoverDirect, the request is rescued via direct egress after proxy exhaustion", async () => {
    _resetUpstreamProxyForTest();
    _resetFetchUtilForTest();
    let requests = 0;
    const upstream = http.createServer((_req, res) => {
        requests++;
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
    });
    await listen(upstream);
    const port = (upstream.address() as { port: number }).port;
    const deadProxyPort = await freePort();
    try {
        const result = await fetchUpstreamResilient(
            `http://127.0.0.1:${port}/v1/chat/completions`,
            { method: "POST", body: "{}" },
            { proxyUrl: `http://127.0.0.1:${deadProxyPort}`, failoverDirect: true, maxRetries: 1, baseDelayMs: 1 },
        );
        assert.equal(result.response.status, 200);
        assert.equal(await result.response.text(), '{"ok":true}');
        assert.equal(result.attempts, 3, "1 initial + 1 retry + 1 direct failover");
        assert.equal(result.failoverDirect, true);
        assert.equal(requests, 1);
        result.clearTimer();
    } finally {
        upstream.closeAllConnections();
        await close(upstream);
        _resetUpstreamProxyForTest();
        _resetFetchUtilForTest();
    }
});

test("parseUpstreamProxyFailover: only explicit \"direct\" opts in", () => {
    assert.equal(parseUpstreamProxyFailover(undefined), undefined);
    assert.equal(parseUpstreamProxyFailover(""), undefined);
    assert.equal(parseUpstreamProxyFailover("off"), undefined);
    assert.equal(parseUpstreamProxyFailover("DIRECT"), undefined);
    assert.equal(parseUpstreamProxyFailover("direct"), "direct");
});

test("loadOptions: upstreamProxyFailover defaults OFF, config file and env opt in", () => {
    const prev = { ...process.env };
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "bili-1041-home-"));
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, ".config");
    process.env.XDG_STATE_HOME = path.join(home, ".local", "state");
    const configDir = path.join(process.env.XDG_CONFIG_HOME, "billion-context");
    fs.mkdirSync(configDir, { recursive: true });
    const configFile = path.join(configDir, "billion-context.json");
    try {
        delete process.env.BILI_UPSTREAM_PROXY_FAILOVER;
        // Fresh sandbox, no file: default OFF.
        assert.equal(loadOptions().upstreamProxyFailover, undefined);
        // Config file opt-in.
        fs.writeFileSync(configFile, JSON.stringify({ upstreamProxyFailover: "direct" }));
        assert.equal(loadOptions().upstreamProxyFailover, "direct");
        // Invalid values stay OFF.
        fs.writeFileSync(configFile, JSON.stringify({ upstreamProxyFailover: "always" }));
        assert.equal(loadOptions().upstreamProxyFailover, undefined);
        // Env mirror wins over the file.
        fs.writeFileSync(configFile, JSON.stringify({}));
        process.env.BILI_UPSTREAM_PROXY_FAILOVER = "direct";
        assert.equal(loadOptions().upstreamProxyFailover, "direct");
    } finally {
        process.env = prev;
        fs.rmSync(home, { recursive: true, force: true });
    }
});
